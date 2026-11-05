import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

const terminalStatuses = [
  'activated',
  'no-change',
  'skipped',
  'rejected',
] as const;
const statuses = [
  'started',
  'evidence-prepared',
  'prepared',
  'validated',
  ...terminalStatuses,
] as const;
export type ReflectionTerminalStatus = (typeof terminalStatuses)[number];
export type ReflectionStatus = (typeof statuses)[number];
export interface ReflectionResult extends JsonObject {
  reflectionId: string;
  status: ReflectionTerminalStatus;
  reason: string;
  revisionRefs: Record<string, string>;
}
export const reflectionResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    reflectionId: { type: 'string' },
    status: { enum: [...terminalStatuses] },
    reason: { type: 'string' },
    revisionRefs: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['reflectionId', 'status', 'reason', 'revisionRefs'],
  additionalProperties: false,
};
export interface ReflectionRecord extends JsonObject {
  status: ReflectionStatus;
}
export function isTerminal(
  status: ReflectionStatus,
): status is ReflectionTerminalStatus {
  return terminalStatuses.some((terminal) => terminal === status);
}
export function readReflectionStatus(value: unknown): ReflectionStatus {
  const status = statuses.find((status) => status === value);
  if (status !== undefined) return status;
  throw new Error(`Reflection status is unsupported: ${String(value)}`);
}
export function readReflectionRecord(value: JsonObject): ReflectionRecord {
  return { ...value, status: readReflectionStatus(value.status) };
}
export function readReflectionResult(
  value: unknown,
  identity?: string,
): ReflectionResult {
  const raw = object(value, 'Reflection result');
  const status = readReflectionStatus(raw.status);
  if (!isTerminal(status))
    throw new Error(`Reflection result status is unsupported: ${status}`);
  validate(reflectionResultSchema, raw, 'Reflection result');
  if (identity !== undefined && raw.reflectionId !== identity)
    throw new Error('Reflection result identity mismatch');
  // The result Schema above owns this protocol/type pairing.
  return raw as ReflectionResult;
}
