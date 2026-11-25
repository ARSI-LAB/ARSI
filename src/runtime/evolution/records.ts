import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

/** Initial revisions have depth zero. Imported fragments can omit an older parent. */
export function revisionDepths(
  records: readonly JsonObject[],
): Map<string, number> {
  const parents = new Map(
    records.map((record) => [String(record.ref), record.parentRef]),
  );
  const depths = new Map<string, number>();
  for (const ref of parents.keys()) {
    const pending = new Set<string>();
    let cursor: string | undefined = ref;
    while (cursor !== undefined && parents.has(cursor) && !depths.has(cursor)) {
      if (pending.has(cursor))
        throw new Error('Cyclic revision ancestry: ' + cursor);
      pending.add(cursor);
      const parent = parents.get(cursor);
      cursor = typeof parent === 'string' ? parent : undefined;
    }
    let depth = (cursor === undefined ? undefined : depths.get(cursor)) ?? -1;
    for (const member of [...pending].reverse()) depths.set(member, ++depth);
  }
  return depths;
}

const terminalStatuses = [
  'activated',
  'no-change',
  'skipped',
  'rejected',
] as const;
const inProgressStatuses = [
  'started',
  'evidence-prepared',
  'prepared',
  'validated',
] as const;
const statuses = [...inProgressStatuses, ...terminalStatuses] as const;
export type RuntimeEvolutionTerminalStatus = (typeof terminalStatuses)[number];
export type RuntimeEvolutionStatus = (typeof statuses)[number];
export interface RuntimeEvolutionResult extends JsonObject {
  evolutionId: string;
  status: RuntimeEvolutionTerminalStatus;
  reason: string;
  revisionRefs: Record<string, string>;
  memoryRef: string | null;
}
export const runtimeEvolutionResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    evolutionId: { type: 'string' },
    status: { enum: [...terminalStatuses] },
    reason: { type: 'string' },
    memoryRef: { type: ['string', 'null'] },
    revisionRefs: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['evolutionId', 'status', 'reason', 'revisionRefs', 'memoryRef'],
  additionalProperties: false,
};
export interface RuntimeEvolutionRecord extends JsonObject {
  status: RuntimeEvolutionStatus;
}
export function isEvolutionInProgress(status: unknown): boolean {
  return inProgressStatuses.some((step) => step === status);
}
export function isTerminal(
  status: RuntimeEvolutionStatus,
): status is RuntimeEvolutionTerminalStatus {
  return terminalStatuses.some((terminal) => terminal === status);
}
export function readEvolutionStatus(value: unknown): RuntimeEvolutionStatus {
  const status = statuses.find((status) => status === value);
  if (status !== undefined) return status;
  throw new Error(`Runtime evolution status is unsupported: ${String(value)}`);
}
export function readEvolutionRecord(value: JsonObject): RuntimeEvolutionRecord {
  return { ...value, status: readEvolutionStatus(value.status) };
}
export function readEvolutionResult(
  value: unknown,
  identity?: string,
): RuntimeEvolutionResult {
  const raw = object(value, 'Runtime evolution result');
  const status = readEvolutionStatus(raw.status);
  if (!isTerminal(status))
    throw new Error(
      `Runtime evolution result status is unsupported: ${status}`,
    );
  validate(runtimeEvolutionResultSchema, raw, 'Runtime evolution result');
  if (identity !== undefined && raw.evolutionId !== identity)
    throw new Error('Runtime evolution result identity mismatch');
  // The result Schema above owns this protocol/type pairing.
  return raw as RuntimeEvolutionResult;
}
