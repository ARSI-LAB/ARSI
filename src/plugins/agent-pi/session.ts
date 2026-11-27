import { outputInstructions } from '../shared/agent-output-instructions.js';
import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/native-agent/result.js';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { createProjectSubagentTool, readProjectRole } from './subagent.js';
import { piObservations } from './observations.js';
import { projectTools } from './project-tools.js';
import { validate, validateSchemaDefinition } from '../../shared/schema.js';
import { configDefaults, type AgentPiConfig } from './schema.js';

/** Resolve only for execution; persisted config keeps environment references. */
export function resolveModelConfig(
  config: AgentPiConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { model: string; base_url: string; api_key: string } {
  const resolve = (field: 'model' | 'base_url' | 'api_key'): string => {
    const value = (config[field] ?? configDefaults[field]).replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        const replacement = environment[name];
        if (replacement === undefined)
          throw new Error(
            `agent.pi ${field} references missing environment variable ${name}`,
          );
        return replacement;
      },
    );
    if (!value.trim())
      throw new Error(`agent.pi ${field} resolved to an empty value`);
    return value;
  };
  return {
    model: resolve('model'),
    base_url: resolve('base_url'),
    api_key: resolve('api_key'),
  };
}
export type PiTask = AgentInput & {
  cwd: string;
  role?: string;
  runId: string;
  parentRunId: string | null;
};
export async function createPiSession(
  config: AgentPiConfig,
  delegate: (
    role: string,
    goal: string,
    parent: PiTask,
    signal: AbortSignal,
  ) => Promise<AgentOutput>,
): Promise<{
  execute(request: PiTask, context: RuntimeContext): Promise<AgentOutput>;
  dispose(): Promise<void>;
}> {
  const {
    contextWindow = configDefaults.contextWindow,
    thinkingLevel = configDefaults.thinkingLevel,
    retries = configDefaults.retries,
    retryBaseDelayMs = configDefaults.retryBaseDelayMs,
  } = config;
  return {
    async execute(request, context) {
      const {
        model: modelName,
        base_url: endpoint,
        api_key: apiKey,
      } = resolveModelConfig(config);
      const signal = context.signal;
      signal.throwIfAborted();
      await mkdir(context.directory, { recursive: true });
      let directory: string | undefined;
      let session:
        | Awaited<ReturnType<typeof createAgentSession>>['session']
        | undefined;
      let unsubscribe: (() => void) | undefined;
      let executionFinished = false;
      const publish = (
        event: import('../../contracts/index.js').AgentObservation,
      ): void => {
        context.event.emit('rsi/agent-observation', event);
      };
      publish({
        runId: request.runId,
        event: {
          type: 'run.started',
          backend: 'agent.pi',
          parentRunId: request.parentRunId,
          ...(request.role ? { role: request.role } : {}),
        },
      });
      const observations = piObservations(publish, request.runId);
      const observe = observeNative(observations.observe, publish, signal);
      const finishMessage = observeNative(
        observations.finishMessage,
        publish,
        signal,
      );
      try {
        directory = await mkdtemp(join(context.directory, 'pi-'));
        signal.throwIfAborted();
        const runtime = await ModelRuntime.create({
          authPath: join(directory, 'auth.json'),
          modelsPath: null,
          modelsStorePath: join(directory, 'models.json'),
          allowModelNetwork: false,
          refreshOnCreate: false,
          signal,
        });
        runtime.registerProvider('rsi', {
          api: 'openai-completions',
          apiKey: 'rsi-runtime-credential',
          baseUrl: endpoint,
          models: [
            {
              id: modelName,
              name: modelName,
              reasoning: thinkingLevel !== 'off',
              thinkingLevelMap: { xhigh: 'xhigh' },
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow,
              maxTokens: config.maxTokens ?? contextWindow,
            },
          ],
        });
        const model = runtime.getModel('rsi', modelName);
        if (!model) throw new Error('Configured Pi model unavailable');
        const schema = request.outputSchema;
        if (request.parentRunId !== null)
          validateSchemaDefinition(schema, 'Pi child outputSchema');
        const settingsManager = SettingsManager.inMemory({
          cacheWarming: 'off',
          compaction: {
            enabled: true,
            ...config.settings?.compaction,
            ...(config.maxTokens === undefined
              ? {}
              : { reserveTokens: config.maxTokens }),
          },
          retry: {
            enabled: retries > 0,
            maxRetries: retries,
            baseDelayMs: retryBaseDelayMs,
            provider: { maxRetries: 0 },
          },
        });
        const cwd = await realpath(request.cwd);
        const agentDir = join(directory, 'agent');
        const path = join(cwd, 'AGENTS.md');
        const skills = join(cwd, '.agents', 'skills');
        const agentsFiles = [{ path, content: await readFile(path, 'utf8') }];
        if (request.role !== undefined)
          agentsFiles.push(await readProjectRole(cwd, request.role));
        const hasSkills = await lstat(skills).then(
          (stat) => stat.isDirectory(),
          () => false,
        );
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          additionalSkillPaths: hasSkills ? [skills] : [],
          agentsFilesOverride: () => ({ agentsFiles }),
          appendSystemPrompt: [],
          systemPrompt: outputInstructions(schema),
        });
        await resourceLoader.reload();
        const tools = projectTools(cwd);
        if (request.role === undefined) {
          const tool = await createProjectSubagentTool(
            cwd,
            (role, goal, toolSignal) =>
              delegate(
                role,
                goal,
                request,
                toolSignal ? AbortSignal.any([signal, toolSignal]) : signal,
              ),
          );
          if (tool) tools.push(tool);
        }
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime: runtime,
          thinkingLevel,
          customTools: tools,
          resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
          settingsManager,
        }));
        unsubscribe = session.subscribe((event) => {
          if (
            (event.type === 'message_end' &&
              event.message.role === 'assistant') ||
            event.type === 'tool_execution_start' ||
            event.type === 'tool_execution_end'
          )
            observe(event);
        });
        let callFailure: Error | undefined;
        const original = session.agent.streamFunction;
        session.agent.streamFunction = async (m, c, o) => {
          signal.throwIfAborted();
          try {
            await context.charge('modelCalls', 1);
          } catch (error) {
            callFailure =
              error instanceof Error ? error : new Error(String(error));
            session?.setAutoRetryEnabled(false);
            throw error;
          }
          signal.throwIfAborted();
          const controller = new AbortController();
          const requestSignal = AbortSignal.any([
            signal,
            ...(o?.signal ? [o.signal] : []),
            controller.signal,
          ]);
          const timer =
            config.timeoutMs === undefined
              ? undefined
              : setTimeout(
                  () =>
                    controller.abort(
                      new DOMException(
                        'Agent model request timed out',
                        'TimeoutError',
                      ),
                    ),
                  config.timeoutMs,
                );
          timer?.unref();
          const release = (): void => {
            clearTimeout(timer);
            requestSignal.removeEventListener('abort', release);
          };
          requestSignal.addEventListener('abort', release, { once: true });
          try {
            const stream = await original(m, c, {
              ...o,
              signal: requestSignal,
              apiKey,
              maxTokens: config.maxTokens,
              maxRetries: 0,
              timeoutMs: config.timeoutMs,
              onPayload:
                config.maxTokens === undefined
                  ? async (payload, model) => {
                      const configured =
                        (await o?.onPayload?.(payload, model)) ?? payload;
                      // Pi's simple stream adds a model-based default to the wire request.
                      if (configured === null || typeof configured !== 'object')
                        return configured;
                      const body = { ...configured };
                      Reflect.deleteProperty(body, 'max_tokens');
                      Reflect.deleteProperty(body, 'max_completion_tokens');
                      return body;
                    }
                  : o?.onPayload,
            });
            void stream.result().then((message) => {
              release();
              const statusText = /^(\d{3})\b/.exec(
                message.errorMessage ?? '',
              )?.[1];
              const status =
                statusText === undefined ? null : Number(statusText);
              // An explicit permanent HTTP status outranks transient-looking provider text.
              if (
                requestSignal.aborted ||
                (status !== null && status !== 429 && status < 500)
              )
                session?.setAutoRetryEnabled(false);
            }, release);
            return stream;
          } catch (error) {
            release();
            throw error;
          }
        };
        const cancel = () => {
          void session?.abort();
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const start = session.messages.length;
          publish({
            runId: request.runId,
            event: {
              type: 'task.submitted',
              text: request.message,
              outputSchema: schema,
            },
          });
          await session.prompt(request.message, {
            expandPromptTemplates: false,
          });
          await session.waitForIdle();
          signal.throwIfAborted();
          if (callFailure) throw callFailure;
          const message = session.messages
            .slice(start)
            .reverse()
            .find((item) => item.role === 'assistant');
          if (
            message?.role === 'assistant' &&
            (message.stopReason === 'error' || message.stopReason === 'aborted')
          )
            throw new Error(
              message.errorMessage ?? `Agent response ${message.stopReason}`,
            );
          const response =
            message?.role === 'assistant'
              ? message.content
                  .filter((item) => item.type === 'text')
                  .map((item) => item.text)
                  .join('')
              : '';
          finishMessage(response);
          publish({
            runId: request.runId,
            event: {
              type: 'run.finished',
              status: message?.role === 'assistant' ? 'completed' : 'unknown',
              ...(message?.role === 'assistant'
                ? { nativeStatus: message.stopReason }
                : {}),
            },
          });
          executionFinished = true;
          const result = parseAgentResult(response);
          if (request.parentRunId !== null)
            validate(schema, result, 'Pi child output');
          return object(result);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      } catch (error) {
        const cause = signal.aborted ? signal.reason : error;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!executionFinished)
          publish({
            runId: request.runId,
            event: {
              type: 'run.finished',
              status: signal.aborted ? 'cancelled' : 'failed',
              error: message,
            },
          });
        throw cause;
      } finally {
        unsubscribe?.();
        try {
          await session?.abort();
        } finally {
          try {
            session?.dispose();
          } finally {
            if (directory)
              await rm(directory, { recursive: true, force: true });
          }
        }
      }
    },
    async dispose() {},
  };
}
