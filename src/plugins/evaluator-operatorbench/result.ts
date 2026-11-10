import { parseKernelAssessment, type KernelAssessment } from 'ember-evaluator';
import type { JsonObject } from '../../contracts/index.js';
import { compareFilePaths } from '../../shared/paths.js';
import { digest, object, string } from '../../shared/json.js';
import { validateSnapshot } from '../shared/evaluator-adapter/measurement.js';
import { fixedConditions } from './conditions.js';
import type { PreparedOperatorCase } from './kernel-input.js';

export type SdkOperatorResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  cleanup: 'confirmed' | 'unknown';
  valid: boolean | null;
  candidateMs: number | null;
  referenceMs: number | null;
  speedup: number | null;
  native: JsonObject;
  assessment: KernelAssessment | null;
  conditions: JsonObject | null;
  profile: JsonObject | null;
  runId: string | null;
  attemptId: string | null;
  diagnostics: {
    code: string;
    message: string;
    sourcePointer?: string;
    truncated?: boolean;
  }[];
};

/** Consume the SDK verdict; kernel correctness, timing and capture audits belong to its Benchmark. */
export function adaptSdkResult(
  value: unknown,
  prepared: PreparedOperatorCase,
): SdkOperatorResult {
  const native = object(value, 'SDK result');
  if (native.kind !== 'local')
    throw new Error('Operator SDK requires local result');
  const snapshot = object(native.snapshot);
  validateSnapshot(snapshot);
  const run = object(snapshot.run);
  if (
    !Array.isArray(run.taskIds) ||
    run.taskIds.length !== 1 ||
    run.taskIds[0] !== prepared.taskId ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length !== 1
  )
    throw new Error('SDK selected task coverage mismatch');
  const record = object(snapshot.records[0]);
  const key = object(record.key);
  if (
    key.taskId !== prepared.taskId ||
    key.runId !== native.runId ||
    key.runId !== run.runId
  )
    throw new Error('SDK run identity mismatch');
  const details =
    record.verdict === null ? null : object(object(record.verdict).details);
  const cleanup =
    record.cleanupStatus === 'cleaned' && details?.cleanup !== 'unconfirmed'
      ? 'confirmed'
      : 'unknown';
  const cancelled =
    record.executionStatus === 'cancelled' || run.status === 'cancelled';
  const diagnostics = Array.isArray(record.errors)
    ? record.errors.map((value, index) => {
        const error = object(value);
        return {
          code: string(error.code),
          message: string(error.message),
          sourcePointer: `/snapshot/records/0/errors/${index}/message`,
        };
      })
    : [];
  const base: SdkOperatorResult = {
    status: cancelled
      ? 'cancelled'
      : cleanup === 'unknown'
        ? 'unknown'
        : 'failed',
    cleanup,
    valid: null,
    candidateMs: null,
    referenceMs: null,
    speedup: null,
    native,
    assessment: null,
    conditions: null,
    profile: null,
    runId: string(native.runId),
    attemptId: string(key.attemptId),
    diagnostics,
  };
  if (
    cancelled ||
    cleanup === 'unknown' ||
    record.executionStatus !== 'completed' ||
    run.status !== 'completed' ||
    native.exitCode !== 0 ||
    diagnostics.length
  )
    return base;
  const collection = object(record.collection);
  if (
    collection.artifacts !== 'complete' ||
    collection.trajectory !== 'complete' ||
    (Array.isArray(snapshot.pendingTaskIds) && snapshot.pendingTaskIds.length)
  )
    throw new Error('Incomplete SDK collection');
  const verdict = object(record.verdict);
  const profileOperation = prepared.operation === 'profile';
  if (
    !details ||
    details.protocol !==
      (profileOperation ? 'kernel-profile/v1' : 'kernel-v1') ||
    details.candidateSha256 !== prepared.candidateSha256 ||
    object(record.solve).finalText !== prepared.candidateSha256
  )
    throw new Error('SDK kernel source identity mismatch');
  const inventory = prepared.sourceInventory;
  const files = object(run.source).files;
  if (!Array.isArray(files)) throw new Error('Missing SDK source files');
  const actual = files
    .map((value) => object(value))
    .filter(
      (file) =>
        typeof file.path === 'string' &&
        file.path.startsWith('data/candidate/'),
    )
    .map((file) => ({
      path: string(file.path).slice('data/candidate/'.length),
      sha256: string(file.sha256),
    }))
    .sort(compareFilePaths);
  if (digest(actual) !== digest([...inventory.files].sort(compareFilePaths)))
    throw new Error('SDK kernel source inventory identity mismatch');
  const conditions = fixedConditions(run, prepared);
  const references = conditions.fixedFiles.filter(
    (file) => file.path === 'data/problem.py',
  );
  if (
    references.length !== 1 ||
    references[0]?.sha256 !== prepared.referenceSha256
  )
    throw new Error('SDK kernel reference source identity mismatch');
  const profile =
    details.profiling === undefined ? null : object(details.profiling);
  if (profileOperation)
    return {
      ...base,
      status: 'completed',
      profile,
      conditions: {
        ...conditions,
        operation: 'profile',
        protocol: object(details.diagnosticProtocol),
      },
    };
  if (record.scoreStatus !== 'valid') return base;
  const assessment = parseKernelAssessment(
    details.assessment,
    prepared.contract,
    [prepared.seed],
  );
  if (verdict.passed !== true && verdict.passed !== false)
    throw new Error('Missing SDK candidate verdict');
  if (!verdict.passed)
    return {
      ...base,
      status: 'completed',
      valid: false,
      conditions,
      assessment,
      diagnostics: [
        {
          code: 'KERNEL_CONTRACT_FAILED',
          message: String(details.error || 'Strict candidate check failed'),
        },
      ],
    };
  const number = (name: string): number => {
    const value = details[name];
    if (typeof value !== 'number') throw new Error(`Missing SDK ${name}`);
    return value;
  };
  const summary =
    profile === null
      ? null
      : JSON.stringify({
          status: profile.status,
          metadata: profile.metadata,
          kernels: profile.kernels,
          error: profile.error,
        });
  return {
    ...base,
    status: 'completed',
    valid: true,
    assessment,
    profile,
    candidateMs: number('candidateMs'),
    referenceMs: number('referenceMs'),
    speedup: number('speedup'),
    conditions: {
      ...conditions,
      mode: 'sdk',
      contract: prepared.contract,
      protocol: assessment.effectiveProtocol,
      environment: assessment.environment,
    },
    diagnostics:
      summary === null
        ? []
        : [
            {
              code: 'KERNEL_PROFILE_SUMMARY',
              message:
                summary.length > 3600
                  ? summary.slice(0, 3500) + ' [truncated; see source artifact]'
                  : summary,
              sourcePointer: '/snapshot/records/0/verdict/details/profiling',
              truncated: summary.length > 3600,
            },
          ],
  };
}
