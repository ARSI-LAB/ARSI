import { adaptProfileResult } from './profile-result.js';
import { parseKernelAssessment, type KernelAssessment } from 'ember-evaluator';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validateSnapshot } from '../shared/evaluator-adapter/measurement.js';
import type { PreparedSdkRun } from './sdk-configuration.js';
import type { SdkOperatorbenchConfig } from './schema.js';

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

export function adaptSdkResult(
  value: unknown,
  prepared: PreparedSdkRun,
  config: SdkOperatorbenchConfig,
  seed: number,
): SdkOperatorResult {
  const native = object(value, 'SDK result');
  if (native.kind !== 'local')
    throw new Error('Operator SDK requires local result');
  const snapshot = object(native.snapshot);
  validateSnapshot(snapshot);
  const run = object(snapshot.run);
  const records = snapshot.records;
  if (
    !Array.isArray(run.taskIds) ||
    run.taskIds.length !== 1 ||
    run.taskIds[0] !== prepared.taskId ||
    !Array.isArray(records) ||
    records.length !== 1
  )
    throw new Error('SDK selected task coverage mismatch');
  const record = object(records[0]);
  const key = object(record.key);
  if (
    key.taskId !== prepared.taskId ||
    key.runId !== native.runId ||
    key.runId !== run.runId
  )
    throw new Error('SDK run identity mismatch');
  const cleanup = record.cleanupStatus === 'cleaned' ? 'confirmed' : 'unknown';
  const cancelled =
    record.executionStatus === 'cancelled' || run.status === 'cancelled';
  const diagnostics = Array.isArray(record.errors)
    ? record.errors.map((error) => {
        const e = object(error);
        return {
          code: string(e.code),
          message: string(e.message).slice(0, 4000),
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
  const verdict = record.verdict === null ? null : object(record.verdict);
  const details =
    verdict?.details === undefined ? null : object(verdict.details);
  if (details?.cleanup === 'unconfirmed')
    return { ...base, status: 'unknown', cleanup: 'unknown' };
  if (prepared.operation === 'profile')
    return adaptProfileResult(base, record, run, prepared, config, seed);
  if (
    cancelled ||
    cleanup === 'unknown' ||
    record.executionStatus !== 'completed' ||
    record.scoreStatus !== 'valid' ||
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
  if (
    !details ||
    details.protocol !== 'kernel-v1' ||
    details.candidateSha256 !== prepared.candidateSha256 ||
    object(record.solve).finalText !== prepared.candidateSha256 ||
    details.referenceKind !== 'pytorch'
  )
    throw new Error('SDK kernel source identity mismatch');
  const assessment = parseKernelAssessment(
    details.assessment,
    prepared.contract,
    [seed],
  );
  for (const name of ['rtol', 'atol', 'warmup', 'repeat'] as const)
    if (assessment.effectiveProtocol[name] !== config.protocol[name])
      throw new Error(`SDK effective protocol ${name} mismatch`);
  const source = object(run.source);
  if (!Array.isArray(source.files)) throw new Error('Missing SDK source files');
  const files = source.files.map((v) => {
    const f = object(v);
    return { path: string(f.path), sha256: string(f.sha256) };
  });
  if (
    new Set(files.map((f) => f.path)).size !== files.length ||
    files.some((f) => !/^[a-f0-9]{64}$/u.test(f.sha256))
  )
    throw new Error('Invalid SDK source lock');
  if (
    files.find((f) => f.path === 'data/input.py')?.sha256 !==
      prepared.candidateSha256 ||
    files.find((f) => f.path === 'data/problem.py')?.sha256 !==
      prepared.referenceSha256
  )
    throw new Error('SDK locked source mismatch');
  for (const path of [
    'runtime/precision.py',
    'runtime/strict.py',
    'runtime/timing.py',
  ])
    if (!files.some((f) => f.path === path))
      throw new Error(`Missing SDK locked ${path}`);
  const valid = verdict?.passed === true;
  if (
    valid
      ? assessment.checks.some((c) => c.status !== 'passed') ||
        assessment.errorOwnership !== null
      : verdict?.passed !== false ||
        assessment.errorOwnership !== 'candidate' ||
        !assessment.checks.some((c) => c.status === 'failed')
  )
    throw new Error('SDK correctness lacks strict evidence');
  if (!valid)
    return {
      ...base,
      status: 'completed',
      valid: false,
      assessment,
      diagnostics: [
        {
          code: 'KERNEL_CONTRACT_FAILED',
          message: String(details.error || 'Strict candidate check failed'),
        },
      ],
    };
  if (Object.values(assessment.environment).some((v) => v === null))
    throw new Error('SDK required environment identity unavailable');
  const positive = (name: string): number => {
    const n = details[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid SDK ${name}`);
    return n;
  };
  const candidateMs = positive('candidateMs'),
    referenceMs = positive('referenceMs'),
    speedup = positive('speedup');
  if (
    Math.abs(referenceMs / candidateMs - speedup) >
    1e-8 * Math.max(1, speedup)
  )
    throw new Error('Inconsistent SDK speedup');
  const fixedFiles = files
    .filter((f) => !['manifest.json', 'data/input.py'].includes(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const conditions = object({
    mode: 'sdk',
    contract: prepared.contract,
    protocol: assessment.effectiveProtocol,
    environment: assessment.environment,
    fixedFiles,
    sdkIdentity: run.identity ?? null,
    pluginVersions: run.pluginVersions,
  });
  const profile =
    details.profiling === undefined ? null : object(details.profiling);
  const profileSummary =
    profile === null
      ? ''
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
    candidateMs,
    referenceMs,
    speedup,
    assessment,
    conditions,
    profile,
    diagnostics:
      profile === null
        ? []
        : [
            {
              code: 'KERNEL_PROFILE_SUMMARY',
              message:
                profileSummary.length > 3600
                  ? profileSummary.slice(0, 3500) +
                    ' [truncated; see source artifact]'
                  : profileSummary,
              sourcePointer: '/snapshot/records/0/verdict/details/profiling',
              truncated: profileSummary.length > 3600,
            },
          ],
  };
}
