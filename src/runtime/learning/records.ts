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
export type LearningTerminalStatus = (typeof terminalStatuses)[number];
export type LearningStatus = (typeof statuses)[number];
export interface LearningResult extends JsonObject {
  learningId: string;
  status: LearningTerminalStatus;
  reason: string;
  revisionRefs: Record<string, string>;
  memoryRef: string | null;
}
export const learningResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    learningId: { type: 'string' },
    status: { enum: [...terminalStatuses] },
    reason: { type: 'string' },
    memoryRef: { type: ['string', 'null'] },
    revisionRefs: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['learningId', 'status', 'reason', 'revisionRefs', 'memoryRef'],
  additionalProperties: false,
};
export interface LearningRecord extends JsonObject {
  status: LearningStatus;
}
export function isLearningInProgress(status: unknown): boolean {
  return inProgressStatuses.some((step) => step === status);
}
export function isTerminal(
  status: LearningStatus,
): status is LearningTerminalStatus {
  return terminalStatuses.some((terminal) => terminal === status);
}
export function readLearningStatus(value: unknown): LearningStatus {
  const status = statuses.find((status) => status === value);
  if (status !== undefined) return status;
  throw new Error(`Learning status is unsupported: ${String(value)}`);
}
export function readLearningRecord(value: JsonObject): LearningRecord {
  return { ...value, status: readLearningStatus(value.status) };
}
export function readLearningResult(
  value: unknown,
  identity?: string,
): LearningResult {
  const raw = object(value, 'Learning result');
  const status = readLearningStatus(raw.status);
  if (!isTerminal(status))
    throw new Error(`Learning result status is unsupported: ${status}`);
  validate(learningResultSchema, raw, 'Learning result');
  if (identity !== undefined && raw.learningId !== identity)
    throw new Error('Learning result identity mismatch');
  // The result Schema above owns this protocol/type pairing.
  return raw as LearningResult;
}
