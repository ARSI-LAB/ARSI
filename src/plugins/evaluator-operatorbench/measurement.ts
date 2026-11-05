import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../contracts/index.js';
import type { KernelExecution } from '../application-kernel/schema.js';
import {
  evaluationFeedbackSchema,
  measurementEvidenceSchema,
  measurementItemsSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { typed } from '../shared/evaluator-adapter/measurement.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import {
  sdkConditionsSchema,
  sdkProvenanceSchema,
  sdkDetailsSchema,
} from './schema.js';
import type { SdkOperatorResult } from './result.js';

export async function recordSdkMeasurement(
  result: SdkOperatorResult,
  candidateRef: string,
  caseId: string,
  execution: KernelExecution,
  conditions: JsonObject,
  entries: JsonValue[],
  context: RuntimeContext,
  operation: 'evaluate' | 'profile',
): Promise<string> {
  const rawRef = await context.artifacts.putJson(result.native);
  const completed =
    result.status === 'completed' && result.cleanup === 'confirmed';
  const isProfile = operation === 'profile';
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
    unit: string,
    value: number | null,
    pointer: string,
  ): Promise<JsonObject> => {
    const definitionRef = await definition(
      context.artifacts,
      id,
      unit,
      'scalar',
      `kernel-v1 ${id}`,
      'single fixed case; native mean',
    );
    return value === null
      ? {
          definitionRef,
          status: 'unavailable',
          value: null,
          reason: 'No confirmed measurement',
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
  const metrics = isProfile
    ? {}
    : {
        candidateValid: await scalar(
          'candidateValid',
          'boolean',
          completed && result.valid !== null ? Number(result.valid) : null,
          pointer + '/assessment/checks',
        ),
        latencyMeanMs: await scalar(
          'latencyMeanMs',
          'ms',
          valid ? result.candidateMs : null,
          pointer + '/candidateMs',
        ),
        referenceMeanMs: await scalar(
          'referenceMeanMs',
          'ms',
          valid ? result.referenceMs : null,
          pointer + '/referenceMs',
        ),
        speedupVsReference: await scalar(
          'speedupVsReference',
          'ratio',
          valid ? result.speedup : null,
          pointer + '/speedup',
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
    primaryReward: isProfile ? null : 'latencyMeanMs',
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
    operation: isProfile ? 'profile' : 'evaluate',
    sourceDigest: execution.sourceDigest,
    caseId,
    assessment: result.assessment,
    profile: result.profile,
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
        sourceDigest: execution.sourceDigest,
        artifactRef: execution.artifactRef,
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

export async function readProfileAssessment(
  ref: string,
  candidateRef: string,
  identity: {
    taskDigest: string;
    sdkBuildDigest: string;
    adapterDigest: string;
    caseId: string;
    seed: number;
  },
  context: RuntimeContext,
): Promise<{
  conditions: JsonObject;
  sourceDigest: string;
  comparisonKey: string;
}> {
  const measurement = await context.readMeasurement(ref);
  if (
    measurement.experimentId !== context.experimentId ||
    measurement.candidateRef !== candidateRef ||
    measurement.status !== 'succeeded' ||
    measurement.coverage !== 'complete' ||
    object(object(object(measurement.metrics).candidateValid).value).value !== 1
  )
    throw new Error(
      'Diagnostic assessment must be valid and belong to this candidate and experiment',
    );
  const conditions = object(
    await context.artifacts.readJson(
      string(object(measurement.conditions).artifactRef),
    ),
  );
  const provenance = object(
    await context.artifacts.readJson(
      string(object(measurement.provenance).artifactRef),
    ),
  );
  if (
    conditions.taskDigest !== identity.taskDigest ||
    conditions.sdkBuildDigest !== identity.sdkBuildDigest ||
    conditions.adapterDigest !== identity.adapterDigest ||
    provenance.cleanup !== 'confirmed'
  )
    throw new Error(
      'Diagnostic assessment task, build or cleanup identity mismatch',
    );
  const evaluation = object(conditions.evaluation);
  if (
    object(evaluation.contract).caseId !== identity.caseId ||
    digest(object(evaluation.protocol).seeds) !== digest([identity.seed])
  )
    throw new Error('Diagnostic assessment case or seed mismatch');
  if (evaluation.operation === 'profile')
    throw new Error('Diagnostic cannot certify another diagnostic');
  return {
    conditions: evaluation,
    sourceDigest: string(provenance.sourceDigest),
    comparisonKey: string(measurement.comparisonKey),
  };
}
