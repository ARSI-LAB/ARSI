import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { digest, string } from '../../shared/json.js';
import type { LocalProvider } from './local-config.js';

export function configurationSnapshot(
  version: string,
  local: JsonObject,
  provider: LocalProvider,
  thread: JsonObject,
): JsonObject {
  return {
    schemaVersion: 'rsi.agent-codex-config/v1',
    cliVersion: version,
    model: string(thread.model, 'effective Codex model'),
    provider: provider.id,
    reasoningEffort: thread.reasoningEffort ?? null,
    serviceTier: thread.serviceTier ?? null,
    endpointFingerprint: digest({
      api: provider.apiBaseUrl,
      chatgpt: provider.chatgptBaseUrl,
    }),
    contextWindow: local.model_context_window ?? null,
    autoCompactTokenLimit: local.model_auto_compact_token_limit ?? null,
  };
}

/** Persist only non-secret execution settings. A resumed or concurrent call cannot silently drift. */
export async function acceptConfiguration(
  context: RuntimeContext,
  snapshot: JsonObject,
): Promise<string> {
  const id = digest({
    experimentId: context.experimentId,
    bindingId: context.bindingId,
  });
  const fingerprint = digest(snapshot);
  let previous: JsonObject | undefined;
  try {
    previous = await context.facts.read('agent-codex-configurations', id);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (previous && previous.fingerprint !== fingerprint)
    throw new Error(
      'Local Codex execution configuration changed within this experiment; restore the recorded settings or start a new experiment',
    );
  if (!previous)
    await context.facts.write('agent-codex-configurations', id, {
      experimentId: context.experimentId,
      bindingId: context.bindingId,
      fingerprint,
      configuration: snapshot,
    });
  return fingerprint;
}
