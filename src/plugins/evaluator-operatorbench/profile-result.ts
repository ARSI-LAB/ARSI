import type { JsonObject } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import type { PreparedSdkRun } from './sdk-configuration.js';
import type { SdkOperatorbenchConfig } from './schema.js';
import type { SdkOperatorResult } from './sdk-result.js';

/** Diagnostic completion is independent of correctness and benchmark scoring. */
export function adaptProfileResult(
  base: SdkOperatorResult,
  record: JsonObject,
  run: JsonObject,
  prepared: PreparedSdkRun,
  config: SdkOperatorbenchConfig,
  seed: number,
): SdkOperatorResult {
  if (
    base.cleanup !== 'confirmed' ||
    base.status === 'cancelled' ||
    record.executionStatus !== 'completed' ||
    run.status !== 'completed' ||
    base.native.exitCode !== 0 ||
    base.diagnostics.length
  )
    return base;
  const collection = object(record.collection);
  if (
    collection.artifacts !== 'complete' ||
    collection.trajectory !== 'complete'
  )
    throw new Error('Incomplete SDK diagnostic collection');
  const verdict = object(record.verdict);
  const details = object(verdict.details);
  if (
    verdict.passed !== null ||
    details.protocol !== 'kernel-profile/v1' ||
    details.operation !== 'profile' ||
    details.candidateSha256 !== prepared.candidateSha256 ||
    details.referenceKind !== 'pytorch' ||
    object(record.solve).finalText !== prepared.candidateSha256
  )
    throw new Error('SDK diagnostic source identity mismatch');
  const protocol = object(details.diagnosticProtocol);
  if (
    protocol.caseId !== prepared.taskId ||
    digest(protocol.seeds) !== digest([seed]) ||
    protocol.warmup !== (config.sdk.profiling.warmup ?? 25) ||
    protocol.capture !== 'after-warmup-mstx-range' ||
    protocol.collection !==
      (config.sdk.profiling.collection ?? 'PipeTimeline,Default')
  )
    throw new Error('SDK diagnostic seed or protocol mismatch');
  const profile = object(details.profiling);
  if (
    !['completed', 'unavailable'].includes(string(details.status)) ||
    profile.status !== (details.status === 'completed' ? 'completed' : 'failed')
  )
    throw new Error('SDK diagnostic status mismatch');
  const files = object(run.source).files;
  if (!Array.isArray(files))
    throw new Error('Missing SDK diagnostic source lock');
  const locked = files.map((v) => object(v));
  if (
    new Set(locked.map((f) => f.path)).size !== locked.length ||
    locked.some(
      (f) => typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(f.sha256),
    )
  )
    throw new Error('Invalid diagnostic source lock');
  for (const [path, hash] of [
    ['data/input.py', prepared.candidateSha256],
    ['data/problem.py', prepared.referenceSha256],
  ])
    if (locked.find((f) => f.path === path)?.sha256 !== hash)
      throw new Error('SDK diagnostic locked source mismatch');
  if (!locked.some((f) => f.path === 'runtime/msprof_replay.py'))
    throw new Error('Missing SDK locked diagnostic replay');
  if (details.status === 'completed') {
    const metadata = object(profile.metadata);
    if (metadata.collection !== protocol.collection)
      throw new Error('SDK diagnostic native collection protocol mismatch');
    const trace = object(metadata.trace ?? {});
    if (
      protocol.collection === 'Default'
        ? trace.status !== 'unavailable' ||
          trace.reason !== 'not-requested-by-default-protocol'
        : trace.status !== 'available'
    )
      throw new Error('SDK diagnostic trace availability mismatch');
    const sources = object(metadata.sources);
    if (
      object(sources.candidate).sha256 !== prepared.candidateSha256 ||
      object(sources.problem).sha256 !== prepared.referenceSha256
    )
      throw new Error('SDK diagnostic native source mismatch');
  }
  return {
    ...base,
    status: 'completed',
    valid: null,
    profile,
    conditions: {
      operation: 'profile',
      protocol,
      sdkIdentity: run.identity ?? null,
      pluginVersions: run.pluginVersions ?? null,
      fixedFiles: locked.filter(
        (f) => !['manifest.json', 'data/input.py'].includes(String(f.path)),
      ),
    },
  };
}
