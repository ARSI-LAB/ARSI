import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  JsonObject,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import { json, object } from '../../shared/json.js';
import { projectMarker } from '../shared/agent-editing/project.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../shared/schema.js';
import {
  configSchema,
  type AgentKernelConfig,
  type ResolvedAgentKernelConfig,
} from './schema.js';

/** Per-invocation bridge retry ceiling; the experiment budget (modelCalls)
 * stays with the Manager, which charges the reported consumption. */
const BRIDGE_MODEL_CALL_LIMIT = 24;

/**
 * Reconstruct the bridge's flat request document from the managed agent
 * workspace: AGENTS.md carries the composed prompt, editable files live under
 * candidate/ (stripped back to their workspace-relative paths), read-only
 * comparison files keep their own paths, the caller's input metadata and the
 * evidence view live in context/*.json, and skill packs are materialized under
 * .agents/skills/.
 */
async function bridgeRequest(request: AgentInput): Promise<JsonObject> {
  const files: JsonObject = {};
  let input: JsonObject = {};
  const skills: JsonObject[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(request.cwd, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(join(request.cwd, path));
      if (content.includes(0)) continue;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        continue;
      }
      if (path === 'context/input.json') input = object(JSON.parse(text));
      else if (path === 'context/measurements.json')
        input.evidence = JSON.parse(text);
      else if (path.startsWith('.agents/skills/'))
        skills.push({
          path: path.slice('.agents/skills/'.length),
          content: text,
        });
      else if (
        path === 'AGENTS.md' ||
        path === projectMarker ||
        path.startsWith('roles/') ||
        path.startsWith('.codex/')
      )
        continue;
      else
        files[
          path.startsWith('candidate/') ? path.slice('candidate/'.length) : path
        ] = text;
    }
  };
  await walk('');
  return {
    goal: request.goal,
    prompt: await readFile(join(request.cwd, 'AGENTS.md'), 'utf8'),
    input,
    files,
    outputSchema: request.outputSchema,
    maxModelCalls: BRIDGE_MODEL_CALL_LIMIT,
  };
}

/**
 * One bridge invocation proposes one candidate: the request is a single JSON
 * document on stdin, the response a single JSON document on stdout (the same
 * bounded one-shot seam as the lifecycle scripts). Bridge diagnostics may
 * contain host configuration; stderr is never relayed.
 */
async function bridge(
  config: ResolvedAgentKernelConfig,
  request: AgentInput,
  childEnv: Record<string, string>,
  signal: AbortSignal,
): Promise<JsonObject> {
  signal.throwIfAborted();
  const document = await bridgeRequest(request);
  return new Promise<JsonObject>((resolveResult, reject) => {
    const child = spawn(config.executable, [config.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...childEnv },
      detached: process.platform !== 'win32',
    });
    const kill = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () =>
          child.kill(),
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            reject(error);
        }
      }
    };
    const timer = setTimeout(() => {
      kill();
      reject(
        new Error(`agent.kernel bridge timed out after ${config.timeoutMs}ms`),
      );
    }, config.timeoutMs);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
    };
    signal.addEventListener('abort', kill, { once: true });
    let output = '';
    let exceeded = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length + chunk.length > 1024 * 1024) {
        exceeded = true;
        kill();
      } else output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (exceeded) {
        reject(new Error('agent.kernel bridge response exceeded 1 MiB'));
        return;
      }
      if (code !== 0) {
        // The bridge reports its failure reason as {"error": ...} on stdout
        // (stderr may carry host configuration and is never relayed); surface
        // it so the run log names the actual cause.
        let detail = '';
        try {
          const parsed: unknown = JSON.parse(output);
          if (
            parsed &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            typeof (parsed as { error: unknown }).error === 'string'
          ) {
            detail = `: ${(parsed as { error: string }).error}`;
          }
        } catch {
          // stdout was not the bridge's error document; keep the generic line.
        }
        reject(
          new Error(
            `agent.kernel bridge failed with exit code ${String(code)}${detail}`,
          ),
        );
        return;
      }
      try {
        resolveResult(
          object(JSON.parse(output), 'agent.kernel bridge response'),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(document));
  });
}

/**
 * Model-call accounting crosses the process boundary in the response: the
 * bridge reports one integer `modelCalls`, the service charges the experiment
 * budget and strips the field before validating the proposal against the
 * caller's outputSchema. This keeps contract.agent output unconstrained.
 */
function splitModelCalls(response: JsonObject): {
  output: JsonObject;
  modelCalls: number;
} {
  if (!Object.hasOwn(response, 'modelCalls'))
    throw new Error('agent.kernel bridge response must report modelCalls');
  const modelCalls = response.modelCalls;
  if (
    typeof modelCalls !== 'number' ||
    !Number.isSafeInteger(modelCalls) ||
    modelCalls < 0
  )
    throw new Error(
      'agent.kernel bridge modelCalls must be a non-negative integer',
    );
  const output = { ...response };
  delete output.modelCalls;
  return { output, modelCalls };
}

export const createAgentKernel: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentKernelConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentKernelConfig>(
    configSchema,
    rawConfig,
    'agent.kernel config',
  );
  return {
    async execute(request, context: RuntimeContext) {
      json(request);
      const signal = context.signal;
      signal.throwIfAborted();
      const schema = object(request.outputSchema);
      validateSchemaDefinition(schema, 'Agent outputSchema');
      // Forward only named variables; missing names are skipped so the bridge
      // decides whether its own configuration is complete.
      const childEnv: Record<string, string> = {};
      for (const name of config.env) {
        const value = process.env[name];
        if (value !== undefined) childEnv[name] = value;
      }
      const response = await bridge(config, request, childEnv, signal);
      const { output, modelCalls } = splitModelCalls(response);
      const limit = BRIDGE_MODEL_CALL_LIMIT;
      if (modelCalls > limit)
        throw new Error(
          `agent.kernel bridge used ${modelCalls} model calls, exceeding the ${limit}-call budget`,
        );
      if (modelCalls > 0) await context.charge('modelCalls', modelCalls);
      validate(schema, output, 'Agent edit output');
      return output;
    },
    async dispose() {},
  };
};
