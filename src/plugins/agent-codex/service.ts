import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { startGateway } from './gateway.js';
import {
  readLocalConfig,
  readCodexVersion,
  localProvider,
  executionOverrides,
} from './local-config.js';
import { acceptConfiguration, configurationSnapshot } from './configuration.js';
import { runSession } from './session.js';

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
  // Manager can admit concurrent calls on one binding; serialize only configuration acceptance.
  let configurationGate = Promise.resolve();
  return {
    async execute(request, context) {
      json(request);
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timer = setTimeout(
        () => controller.abort(new Error('Codex execution timed out')),
        config.timeoutMs,
      );
      timer.unref();
      let directory: string | undefined;
      let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
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
        const local = await readLocalConfig(
          config.executable,
          directory,
          signal,
        );
        const version = await readCodexVersion(
          config.executable,
          directory,
          signal,
        );
        const provider = localProvider(local);
        gateway = await startGateway(
          provider,
          config.timeoutMs,
          context,
          signal,
          request.maxModelCalls ?? 24,
          record,
        );
        const instructionFile = join(directory, 'instructions.md');
        await writeFile(instructionFile, request.prompt, { mode: 0o600 });
        await writeFile(
          instructionFile + '.compact',
          'Summarize this RSI task. Preserve its goal, authorized file names, tool results and output schema.',
          { mode: 0o600 },
        );
        const id = provider.id === 'openai' ? 'rsi-local-openai' : provider.id;
        const key = `model_providers.${id}`;
        const args = [
          ...executionOverrides(local, instructionFile),
          ...[
            `model_provider=${JSON.stringify(id)}`,
            `${key}.name=${JSON.stringify(provider.name)}`,
            `${key}.requires_openai_auth=${provider.requiresOpenaiAuth}`,
            `${key}.base_url=${JSON.stringify(gateway.url + '/api')}`,
            `${key}.http_headers.X-RSI-Codex=${JSON.stringify(gateway.token)}`,
            `${key}.supports_websockets=false`,
            `${key}.request_max_retries=0`,
            `${key}.stream_max_retries=0`,
            ...(config.model === undefined
              ? []
              : [`model=${JSON.stringify(config.model)}`]),
          ].flatMap((value) => ['-c', value]),
        ];
        try {
          return await runSession({
            executable: config.executable,
            directory,
            args,
            request,
            signal,
            record,
            async onConfiguration(effective) {
              const snapshot = configurationSnapshot(
                version,
                local,
                provider,
                effective,
              );
              const accepted = configurationGate.then(async () => {
                signal.throwIfAborted();
                const fingerprint = await acceptConfiguration(
                  context,
                  snapshot,
                );
                record('execution_configuration', { ...snapshot, fingerprint });
              });
              configurationGate = accepted.catch(() => {});
              await accepted;
            },
          });
        } catch (error) {
          throw gateway.failure() ?? error;
        }
      } catch (error) {
        record('error', {
          message: signal.aborted
            ? 'Codex execution cancelled'
            : 'Codex execution failed',
        });
        throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
        try {
          await gateway?.close();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    },
    async dispose() {},
  };
};
