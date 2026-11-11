import type { FactStore, JsonObject } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';

export type GymSubmissionStatus =
  | 'prepared'
  | 'submitted'
  | 'unknown'
  | 'rejected'
  | 'completed';

export interface GymSubmission {
  schemaVersion: 'rsi.gym-submission/v1';
  key: string;
  candidateRef: string;
  candidateDigest: string;
  baseUrl: string;
  evalId: string | null;
  status: GymSubmissionStatus;
  error: string | null;
  updatedAt: string;
}

const KIND = 'gym-submissions';

/** Stable key over the request shape; a changed scale or task set is a new submission. */
export function gymSubmissionKey(
  candidateRef: string,
  baseUrl: string,
  fingerprint: JsonObject,
): string {
  return 'gym-' + digest({ candidateRef, baseUrl, fingerprint }).slice(0, 32);
}

export async function readGymSubmission(
  facts: FactStore,
  key: string,
): Promise<GymSubmission | null> {
  try {
    return record(await facts.read(KIND, key));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    )
      return null;
    throw error;
  }
}

export async function writeGymSubmission(
  facts: FactStore,
  value: GymSubmission,
): Promise<void> {
  await facts.write(KIND, value.key, { ...value });
}

function record(value: JsonObject): GymSubmission {
  const source = object(value, 'gym submission');
  return {
    schemaVersion: 'rsi.gym-submission/v1',
    key: string(source.key, 'gym submission.key'),
    candidateRef: string(source.candidateRef, 'gym submission.candidateRef'),
    candidateDigest: string(
      source.candidateDigest,
      'gym submission.candidateDigest',
    ),
    baseUrl: string(source.baseUrl, 'gym submission.baseUrl'),
    evalId: typeof source.evalId === 'string' ? source.evalId : null,
    status: status(source.status),
    error: typeof source.error === 'string' ? source.error : null,
    updatedAt: string(source.updatedAt, 'gym submission.updatedAt'),
  };
}

function status(value: unknown): GymSubmissionStatus {
  if (
    value === 'prepared' ||
    value === 'submitted' ||
    value === 'unknown' ||
    value === 'rejected' ||
    value === 'completed'
  )
    return value;
  throw new Error(`unknown gym submission status: ${String(value)}`);
}
