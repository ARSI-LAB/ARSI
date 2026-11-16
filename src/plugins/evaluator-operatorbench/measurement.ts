import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  evaluationFeedbackSchema,
  measurementEvidenceSchema,
  measurementItemsSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { digest, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { typed } from '../shared/evaluator-adapter/measurement.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import { kernelMetricDescriptor } from '../shared/evaluator-adapter/kernel-metrics.js';
import {
  sdkConditionsSchema,
  sdkProvenanceSchema,
  sdkDetailsSchema,
} from './measurement-schema.js';
import type { SdkOperatorResult } from './result.js';

export async function recordSdkMeasurement(
  result: SdkOperatorResult,
  candidateRef: string,
  caseId: string,
  source: {
    artifactRef: string;
    sourceDigest: string;
    sourceBundleDigest: string;
  },
  conditions: JsonObject,
  entries: JsonValue[],
  context: RuntimeContext,
  operation: 'evaluate' | 'profile' | 'preflight',
): Promise<string> {
  const rawRef = await context.artifacts.putJson(result.native);
  const completed =
    result.status === 'completed' && result.cleanup === 'confirmed';
  const isProfile = operation === 'profile';
  const isPreflight = operation === 'preflight';
  const valid =
    completed &&
    (isProfile
      ? result.profile?.status === 'completed'
      : result.valid === true);
  const comparisonKey = valid ? digest(conditions) : null;
  const status =
    result.cleanup === 'unknown'
      ? 'unknown'
      : completed
        ? 'succeeded'
        : result.status;
  const scalar = async (
    id: string,
    value: number | null,
    pointer: string,
    reason = 'No confirmed measurement',
  ): Promise<JsonObject> => {
    const descriptor = kernelMetricDescriptor(id);
    const definitionRef = await definition(
      context.artifacts,
      id,
      descriptor.unit,
      'scalar',
      descriptor.mapping,
      descriptor.aggregation,
    );
    return value === null
      ? {
          definitionRef,
          status: 'unavailable',
          value: null,
          reason,
          source: { artifactRef: rawRef, pointer },
        }
      : {
          definitionRef,
          status: 'available',
          value: { kind: 'scalar', value },
          source: { artifactRef: rawRef, pointer },
        };
  };
  const pointer = '/snapshot/records/0/verdict/details';
  const timing = result.timing;
  const metrics = isProfile
    ? {}
    : {
        candidateValid: await scalar(
          'candidateValid',
          completed && result.valid !== null ? Number(result.valid) : null,
          pointer + '/assessment/checks',
        ),
        latencyMeanMs: await scalar(
          'latencyMeanMs',
          valid ? (timing?.device.meanMs ?? result.candidateMs) : null,
          pointer +
            (timing === null ? '/candidateMs' : '/timing/device/meanMs'),
        ),
        referenceMeanMs: await scalar(
          'referenceMeanMs',
          valid ? result.referenceMs : null,
          pointer + '/referenceMs',
        ),
        speedupVsReference: await scalar(
          'speedupVsReference',
          valid ? result.speedup : null,
          pointer + '/speedup',
        ),
        hostMeanMs: await scalar(
          'hostMeanMs',
          valid ? (timing?.host?.meanMs ?? null) : null,
          pointer + '/timing/host/meanMs',
        ),
        endToEndP50Ms: await scalar(
          'endToEndP50Ms',
          valid ? (timing?.endToEnd?.p50Ms ?? null) : null,
          pointer + '/timing/endToEnd/p50Ms',
        ),
        launchCount: await scalar(
          'launchCount',
          valid && timing !== null ? timing.launchCount : null,
          pointer + '/timing/launchCount',
        ),
        referenceErrorMaxAbs: await scalar(
          'referenceErrorMaxAbs',
          completed && result.errorStats !== null
            ? (result.errorStats.maxAbs ?? null)
            : null,
          pointer + '/errorStats/maxAbs',
        ),
      };
  entries.push({
    id: 'native-sdk',
    kind: 'operator-sdk-result',
    artifactRef: rawRef,
    mediaType: 'application/json',
    sizeBytes: null,
    itemId: caseId,
    attemptId: result.attemptId,
    access: 'execution',
    integrity: completed ? 'complete' : 'partial',
  });
  const evidenceIndexRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries,
  });
  const feedback = object({
    schemaVersion: 'rsi.evaluation-feedback/v1',
    itemId: caseId,
    attemptId: result.attemptId,
    executionStatus: result.status,
    scoreStatus: completed ? 'valid' : 'unknown',
    passed: completed ? result.valid : null,
    primaryReward: isProfile || isPreflight ? null : 'latencyMeanMs',
    passThreshold: null,
    checks: (result.assessment?.checks ?? []).map((c, i) => ({
      id: `${c.id}/seed-${c.seed}/call-${c.call}`,
      status: c.status,
      score: c.status === 'not-run' ? null : c.status === 'passed' ? 1 : 0,
      reason: c.message || null,
      source: {
        artifactRef: rawRef,
        pointer: `${pointer}/assessment/checks/${i}`,
      },
    })),
    checksComplete: completed && result.valid === true,
    diagnostics: result.diagnostics.slice(0, 32).map((d) => ({
      kind: 'operator',
      code: d.code,
      message: d.message,
      source: {
        artifactRef: rawRef,
        pointer: d.sourcePointer ?? '/snapshot/records/0',
      },
      truncated: d.truncated ?? false,
    })),
    truncated: result.diagnostics.length > 32,
    source: { artifactRef: rawRef, pointer },
  });
  const details = object({
    mode: 'sdk',
    operation: isProfile ? 'profile' : isPreflight ? 'preflight' : 'evaluate',
    sourceDigest: source.sourceDigest,
    sourceBundleDigest: source.sourceBundleDigest,
    caseId,
    assessment: result.assessment,
    profile: result.profile,
    tolerance: result.tolerance,
    errorStats: result.errorStats,
    infrastructure: result.infrastructure,
  });
  const detailRef = await typed(
    context,
    'rsi.operator-sdk-details/v1',
    sdkDetailsSchema,
    details,
  );
  const evaluation = await typed(
    context,
    'rsi.evaluation-feedback/v1',
    evaluationFeedbackSchema,
    feedback,
  );
  const catalog = {
    schemaVersion: 'rsi.measurement-items/v1',
    items: [
      {
        id: caseId,
        subject: { kind: 'operator-case', id: caseId, parameters: null },
        status,
        coverage: valid ? 'complete' : 'partial',
        comparisonKey,
        metrics,
        evaluation,
        evidenceIndexRef,
        details: detailRef,
      },
    ],
  };
  const now = new Date().toISOString();
  const measurement = object({
    schemaVersion: 'rsi.measurement/v1',
    ref: 'pending',
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef,
    evaluator: {
      pluginId: 'evaluator.operatorbench',
      implementationDigest: conditions.adapterDigest,
    },
    startedAt: now,
    finishedAt: status === 'unknown' ? null : now,
    status,
    coverage: valid ? 'complete' : 'partial',
    comparisonKey,
    conditions: await typed(
      context,
      'rsi.operator-sdk-conditions/v1',
      sdkConditionsSchema,
      conditions,
    ),
    provenance: await typed(
      context,
      'rsi.operator-sdk-provenance/v1',
      sdkProvenanceSchema,
      {
        mode: 'sdk',
        sourceDigest: source.sourceDigest,
        sourceBundleDigest: source.sourceBundleDigest,
        artifactRef: source.artifactRef,
        runId: result.runId,
        attemptId: result.attemptId,
        realNpuRuns: null,
        cleanup: result.cleanup,
      },
    ),
    metrics,
    itemsRef: await context.artifacts.putJson(catalog),
    evidenceIndexRef,
    profile: detailRef,
    diagnosticsRef: rawRef,
    extensions: [],
  });
  // These are the same public boundaries used by every evaluator.
  validate(measurementEvidenceSchema, {
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries,
  });
  validate(measurementItemsSchema, catalog);
  validateMeasurement(measurement);
  return context.recordMeasurement(measurement);
}
