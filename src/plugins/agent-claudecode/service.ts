import { appendFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { json } from '../../shared/json.js';
import { parseConfig, validateSchemaDefinition } from '../../shared/schema.js';
import {
  configSchema,
  type AgentClaudeCodeConfig,
  type ResolvedAgentClaudeCodeConfig,
} from './schema.js';
import { runSession } from './session.js';

/** Adapt task input and validated JSON output; Claude Code owns its provider and execution settings. */
export const createAgentClaudeCode: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentClaudeCodeConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentClaudeCodeConfig>(
    configSchema,
    rawConfig,
    'agent.claudecode config',
  );
  const active = new Map<AbortController, Promise<unknown>>();
  return {
    async execute(request, context) {
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      if (request.role !== undefined)
        throw new Error('For Claude Code role delegation, use native Agent');
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer =
        config.timeoutMs === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(new Error('Claude Code execution timed out')),
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
      const execution = (async () => {
        try {
          await mkdir(context.directory, { recursive: true });
          const cwd = await realpath(request.cwd);
          // CLI reports tokens, not an authoritative per-upstream-request counter.
          // Do not report invented modelCalls or pretend their budget can be enforced here.
          record('usage_capabilities', {
            modelCalls: 'unavailable',
            tokenUsage: 'native',
          });
          return await runSession({
            config,
            directory: cwd,
            request,
            signal,
            record,
          });
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
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
        controller.abort(new Error('Claude Code agent disposed'));
      await Promise.allSettled(pending.map(([, execution]) => execution));
    },
  };
};
