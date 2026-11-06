import type { FactStore, JsonObject } from '../../contracts/index.js';

export type ExperimentStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface ExperimentRecord extends JsonObject {
  status: ExperimentStatus;
}
/** Persisted lifecycle state is validated before a resumed execution can mutate resources. */
export function readExperimentRecord(value: JsonObject): ExperimentRecord {
  const status = value.status;
  switch (status) {
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return { ...value, status };
    default:
      throw new Error(`Experiment status is unsupported: ${String(status)}`);
  }
}

export type PersistedCleanupState =
  | 'absent'
  | 'resolved'
  | 'unresolved'
  | 'invalid';

/** Only the cleanup fact keyed by the experiment owns its resource-release state. */
export function experimentCleanupState(
  value: JsonObject,
  experimentId: string,
): Exclude<PersistedCleanupState, 'absent'> {
  if (value.experimentId !== experimentId) return 'invalid';
  switch (value.status) {
    case 'succeeded':
    case 'reconciled':
      return 'resolved';
    case 'failed':
    case 'unconfirmed':
      return 'unresolved';
    default:
      return 'invalid';
  }
}

export async function readExperimentCleanupState(
  facts: FactStore,
  experimentId: string,
): Promise<PersistedCleanupState> {
  try {
    return experimentCleanupState(
      await facts.read('cleanup', experimentId),
      experimentId,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return 'absent';
    throw error;
  }
}
