import type { FactStore, JsonObject } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';

export type GymReleaseAttemptStatus =
  | 'running'
  | 'submitting'
  | 'failed'
  | 'completed';

export interface GymReleaseAttempt {
  schemaVersion: 'rsi.gym-release-attempt/v1';
  key: string;
  candidateRef: string;
  incumbentRef: string;
  status: GymReleaseAttemptStatus;
  retryable: boolean;
  promotionRoles: string[];
  error: string | null;
  updatedAt: string;
}

const KIND = 'gym-release-attempts';

export function gymReleaseAttemptKey(
  candidateRef: string,
  incumbentRef: string,
  fingerprint: JsonObject,
): string {
  return (
    'release-' +
    digest({ candidateRef, incumbentRef, fingerprint }).slice(0, 32)
  );
}

export async function readGymReleaseAttempt(
  facts: FactStore,
  key: string,
): Promise<GymReleaseAttempt | null> {
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

export async function writeGymReleaseAttempt(
  facts: FactStore,
  value: GymReleaseAttempt,
): Promise<void> {
  await facts.write(KIND, value.key, { ...value });
}

function record(value: JsonObject): GymReleaseAttempt {
  const source = object(value, 'gym release attempt');
  return {
    schemaVersion: 'rsi.gym-release-attempt/v1',
    key: string(source.key, 'gym release attempt.key'),
    candidateRef: string(
      source.candidateRef,
      'gym release attempt.candidateRef',
    ),
    incumbentRef: string(
      source.incumbentRef,
      'gym release attempt.incumbentRef',
    ),
    status: status(source.status),
    retryable: boolean(source.retryable, 'gym release attempt.retryable'),
    promotionRoles: Array.isArray(source.promotionRoles)
      ? source.promotionRoles.map((role, index) =>
          string(role, `gym release attempt.promotionRoles[${index}]`),
        )
      : [],
    error:
      source.error === null || source.error === undefined
        ? null
        : string(source.error, 'gym release attempt.error'),
    updatedAt: string(source.updatedAt, 'gym release attempt.updatedAt'),
  };
}

function status(value: unknown): GymReleaseAttemptStatus {
  if (
    value === 'running' ||
    value === 'submitting' ||
    value === 'failed' ||
    value === 'completed'
  )
    return value;
  throw new Error(`unknown gym release attempt status: ${String(value)}`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}: expected boolean`);
  return value;
}
