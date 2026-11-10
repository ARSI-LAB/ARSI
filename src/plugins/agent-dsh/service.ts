import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { json, object, string } from '../../shared/json.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../shared/schema.js';
import { projectMarker } from '../shared/agent-editing/project.js';
import { configSchema, type AgentDshConfig } from './schema.js';
import { runDshProcess } from './process.js';

/** DSH owns model routing, tools, credentials, retries and native delegation. */
export const createAgentDsh: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentDshConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<AgentDshConfig & { executable: string }>(
    configSchema,
    rawConfig,
    'agent.dsh config',
  );
  const active = new Map<AbortController, Promise<AgentOutput>>();
  return {
    async execute(request, context) {
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      if (request.role !== undefined)
        throw new Error('For DSH role delegation, use native subagents');
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer =
        config.timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => controller.abort(new Error('DSH execution timed out')),
              config.timeoutMs,
            );
      timer?.unref();
      const record = (type: string, data: unknown): void => {
        appendFileSync(
          join(context.directory, 'diagnostics.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), type, data }) + '\n',
          { mode: 0o600 },
        );
      };
      const execution = (async (): Promise<AgentOutput> => {
        let directory: string | undefined;
        try {
          const cwd = await realpath(request.cwd);
          await mkdir(context.directory, { recursive: true });
          directory = await mkdtemp(join(context.directory, 'dsh-launch-'));
          signal.throwIfAborted();
          // Invocation-only overlay: restore native stored authentication and point
          // instruction/skill discovery at the RSI project without editing user config.
          const patch = join(directory, 'launch.json');
          await writeFile(
            patch,
            JSON.stringify([
              ...['credentials', 'authorization', 'deepseek-account'].map(
                (id) => ({ id, disabled: false }),
              ),
              {
                id: 'agent-instructions',
                config: {
                  maxBytes: 65536,
                  projectRootMarkers: [projectMarker],
                },
              },
              {
                id: 'skill-filesystem',
                config: { customSkillDirs: [join(cwd, '.agents', 'skills')] },
              },
            ]),
            { mode: 0o600 },
          );
          record('usage_capabilities', {
            modelCalls: 'unavailable',
            tokenUsage: 'native-step-events',
          });
          let sessionId: string | undefined;
          let finalText: string | undefined;
          await runDshProcess(
            config.executable,
            cwd,
            patch,
            JSON.stringify({
              goal: request.goal,
              instruction:
                'Read AGENTS.md and follow the project instructions. Use native subagents for delegation, reading roles/<name>.md when a role is listed. Return only the JSON object matching outputSchema in your final answer.',
              outputSchema: request.outputSchema,
            }) +
              '\n\nAfter completing the task, your final response MUST be only the JSON object matching outputSchema above. Do not summarize your work in prose or Markdown. A prose response is a failed task.',
            signal,
            (line) => {
              let value: unknown;
              try {
                value = JSON.parse(line);
              } catch {
                throw new Error('DSH emitted invalid JSON protocol output');
              }
              const event = object(value);
              if (event.type === 'session') {
                if (sessionId !== undefined)
                  throw new Error('DSH emitted duplicate session events');
                sessionId = string(event.sessionId);
                record('session_started', { sessionId });
              } else if (
                event.type === 'status' &&
                event.phase === 'step_end'
              ) {
                const raw =
                  event.usage === undefined ? undefined : object(event.usage);
                const usage =
                  raw === undefined
                    ? null
                    : Object.fromEntries(
                        [
                          'inputTokens',
                          'outputTokens',
                          'totalTokens',
                          'cacheReadTokens',
                          'cacheWriteTokens',
                          'reasoningTokens',
                        ]
                          .filter((key) => typeof raw[key] === 'number')
                          .map((key) => [key, raw[key]!]),
                      );
                record('token_usage', { usage });
              } else if (event.type === 'error') {
                throw new Error(
                  'DSH reported a native execution error; inspect native DSH logs',
                );
              } else if (event.type === 'final') {
                if (
                  sessionId === undefined ||
                  event.sessionId !== sessionId ||
                  finalText !== undefined
                )
                  throw new Error('Invalid DSH final event session');
                if (object(event.reason).kind !== 'completed')
                  throw new Error('DSH task did not complete');
                finalText = string(event.text);
              }
            },
          );
          if (finalText === undefined)
            throw new Error(
              'DSH returned no final result (requires headless --json support)',
            );
          const trimmed = finalText.trim();
          const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
          let output: unknown;
          try {
            output = JSON.parse(fenced?.[1] ?? trimmed);
          } catch {
            record('validation_failed', { reason: 'invalid-json' });
            throw new Error('DSH final response is not valid JSON');
          }
          validate(request.outputSchema, output, 'agent output');
          record('validation_succeeded', {});
          return object(output);
        } finally {
          clearTimeout(timer);
          controller.abort();
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
      active.set(controller, execution);
      try {
        return await execution;
      } finally {
        active.delete(controller);
      }
    },
    async dispose() {
      const pending = [...active.entries()];
      for (const [controller] of pending)
        controller.abort(new Error('DSH agent disposed'));
      await Promise.allSettled(pending.map(([, execution]) => execution));
    },
  };
};
