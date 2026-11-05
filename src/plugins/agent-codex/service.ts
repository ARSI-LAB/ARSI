import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  type AgentCodexConfig,
  type ResolvedAgentCodexConfig,
} from './schema.js';
import { runSession } from './session.js';

/** Adapt task input and validated JSON output; Codex owns its provider and execution settings. */
export const createAgentCodex: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentCodexConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<ResolvedAgentCodexConfig>(
    configSchema,
    rawConfig,
    'agent.codex config',
  );
  return {
    async execute(request, context) {
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer =
        config.timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => controller.abort(new Error('Codex execution timed out')),
              config.timeoutMs,
            );
      timer?.unref();
      let directory: string | undefined;
      const record = (type: string, data: unknown): void => {
        appendFileSync(
          join(context.directory, 'diagnostics.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), type, data }) + '\n',
          { mode: 0o600 },
        );
      };
      try {
        await mkdir(context.directory, { recursive: true });
        directory = await mkdtemp(join(tmpdir(), 'rsi-codex-'));
        // App-server reports tokens, not an authoritative per-upstream-request counter.
        // Do not report invented modelCalls or pretend their budget can be enforced here.
        record('usage_capabilities', {
          modelCalls: 'unavailable',
          tokenUsage: 'native',
          maxModelCallsEnforced: false,
        });
        return await runSession({
          executable: config.executable,
          directory,
          model: config.model,
          reasoningEffort: config.thinkingLevel,
          request,
          signal,
          record,
        });
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
    async dispose() {},
  };
};
