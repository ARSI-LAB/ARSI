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

export function distribution(samples: number[]): JsonObject {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return {
    kind: 'distribution',
    count: sorted.length,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

export type SdkCaseMeasurement = {
  caseId: string;
  result: SdkOperatorResult;
  entries: JsonValue[];
};

/**
 * Aggregate evaluate outcome shared by the measurement record and the call
 * output the policy consumes: unconfirmed cleanup outranks cancellation
 * (device state unverifiable), a cancelled case is 'cancelled', everything
 * else non-completed is 'failed'.
 */
export function sdkEvaluationStatus(
  cases: Pick<SdkCaseMeasurement, 'result'>[],
): 'succeeded' | 'failed' | 'cancelled' | 'unknown' {
  const completed = cases.every(
    (c) => c.result.status === 'completed' && c.result.cleanup === 'confirmed',
  );
  if (completed) return 'succeeded';
  if (cases.some((c) => c.result.cleanup === 'unknown')) return 'unknown';
  if (cases.some((c) => c.result.status === 'cancelled')) return 'cancelled';
  return 'failed';
}

/**
 * Multi-case evaluate measurement: one item per case plus measurement-level
 * aggregate metrics. The policy selects on the latencyMs distribution (p50);
 * latencyMeanMs stays available at measurement level for scalar consumers.
 */
export async function recordSdkEvaluateMeasurement(
  cases: SdkCaseMeasurement[],
  candidateRef: string,
  execution: KernelExecution,
  conditionsBase: JsonObject,
  context: RuntimeContext,
  tiling: JsonObject | null,
): Promise<string> {
  const completed = cases.every(
    (c) => c.result.status === 'completed' && c.result.cleanup === 'confirmed',
  );
  const valid = completed && cases.every((c) => c.result.valid === true);
  const caseIds = cases.map((c) => c.caseId);
  // Ember consumers (proposer-operator identity checks) verify that the
  // comparison key is the digest of the full conditions artifact, so the
  // evaluation block — from the first completed case — must stay part of
  // the measured conditions instead of collapsing to null.
  const evaluation = completed ? (cases[0]!.result.conditions ?? null) : null;
  const conditions = { ...conditionsBase, evaluation };
  const comparisonKey = valid ? digest(conditions) : null;
  const status = sdkEvaluationStatus(cases);
  const entries: JsonObject[] = [];
  const digestCases: JsonObject[] = [];
  const items: JsonObject[] = [];
  const candidateMsValues: number[] = [];
  for (const { caseId, result, entries: caseEntries } of cases) {
    const caseCompleted =
      result.status === 'completed' && result.cleanup === 'confirmed';
    const caseValid = caseCompleted && result.valid === true;
    const rawRef = await context.artifacts.putJson(result.native);
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
    if (caseValid && result.candidateMs !== null)
      candidateMsValues.push(result.candidateMs);
    // The SDK strict assessment has no dedicated checksum check; correctness
    // is enforced by the strict checks, so checksum_match stays unavailable.
    const checksumMatch: boolean | null = null;
    const metrics: JsonObject = {
      candidateValid: await scalar(
        'candidateValid',
        'boolean',
        caseCompleted && result.valid !== null ? Number(result.valid) : null,
        pointer + '/assessment/checks',
      ),
      latencyMeanMs: await scalar(
        'latencyMeanMs',
        'ms',
        caseValid ? result.candidateMs : null,
        pointer + '/candidateMs',
      ),
      referenceMeanMs: await scalar(
        'referenceMeanMs',
        'ms',
        caseValid ? result.referenceMs : null,
        pointer + '/referenceMs',
      ),
      speedupVsReference: await scalar(
        'speedupVsReference',
        'ratio',
        caseValid ? result.speedup : null,
        pointer + '/speedup',
      ),
      checksum_match: await scalar(
        'checksum_match',
        'boolean',
        checksumMatch === null ? null : checksumMatch ? 1 : 0,
        pointer + '/assessment/checks',
      ),
    };
    for (const entry of caseEntries) entries.push(object(entry));
    entries.push({
      id: 'native-sdk',
      kind: 'operator-sdk-result',
      artifactRef: rawRef,
      mediaType: 'application/json',
      sizeBytes: null,
      itemId: caseId,
      attemptId: result.attemptId,
      access: 'execution',
      integrity: caseCompleted ? 'complete' : 'partial',
    });
    digestCases.push({
      id: caseId,
      checksumMatch,
      p50Us:
        caseValid && result.candidateMs !== null
          ? result.candidateMs * 1000
          : null,
      p99Us:
        caseValid && result.candidateMs !== null
          ? result.candidateMs * 1000
          : null,
      diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`),
    });
    const feedback = object({
      schemaVersion: 'rsi.evaluation-feedback/v1',
      itemId: caseId,
      attemptId: result.attemptId,
      executionStatus: result.status,
      scoreStatus: caseCompleted
        ? result.valid
          ? 'valid'
          : 'invalid'
        : 'unknown',
      passed: caseCompleted ? result.valid : null,
      primaryReward: 'latencyMeanMs',
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
      checksComplete: caseCompleted && result.valid === true,
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
      operation: 'evaluate',
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
    items.push({
      id: caseId,
      subject: { kind: 'operator-case', id: caseId, parameters: null },
      status:
        result.cleanup === 'unknown'
          ? 'unknown'
          : caseCompleted
            ? 'succeeded'
            : result.status,
      coverage: caseValid ? 'complete' : 'partial',
      comparisonKey: caseValid
        ? digest({ ...conditionsBase, caseIds: [caseId] })
        : null,
      metrics,
      evaluation,
      evidenceIndexRef: await context.artifacts.putJson({
        schemaVersion: 'rsi.measurement-evidence/v1',
        entries: [
          ...caseEntries.map((e) => object(e)),
          {
            id: 'native-sdk',
            kind: 'operator-sdk-result',
            artifactRef: rawRef,
            mediaType: 'application/json',
            sizeBytes: null,
            itemId: caseId,
            attemptId: result.attemptId,
            access: 'execution',
            integrity: caseCompleted ? 'complete' : 'partial',
          },
        ],
      }),
      details: detailRef,
    });
  }
  // Compact per-case digest as execution-visible evidence: the evidence
  // projection only exposes final-text/trajectory entries, so without this
  // neither the proposer nor the memory agent can see what a round actually
  // measured. SDK timing is the native mean, reported as both p50/p99.
  const digestValue = {
    schemaVersion: 'rsi.operatorbench-digest/v1',
    tiling,
    allCompleted: completed,
    checksumMatch: completed
      ? digestCases.every((c) => c.checksumMatch !== false) &&
        digestCases.some((c) => c.checksumMatch !== null)
        ? digestCases.every((c) => c.checksumMatch === true)
        : null
      : null,
    cases: digestCases,
  };
  const digestText = JSON.stringify(digestValue, null, 2);
  entries.push({
    id: 'cases-digest',
    kind: 'final-text',
    artifactRef: await context.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'cases-digest.json',
          mode: 420,
          base64: Buffer.from(digestText, 'utf8').toString('base64'),
        },
      ],
    }),
    mediaType: 'application/json',
    sizeBytes: Buffer.byteLength(digestText),
    itemId: null,
    attemptId: null,
    access: 'execution',
    integrity: completed ? 'complete' : 'partial',
  });
  const evidenceIndexRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries,
  });
  const meanOf = async (
    id: string,
    unit: string,
    values: (number | null)[],
  ): Promise<JsonObject> => {
    const confirmed = values.every((v) => v !== null);
    const definitionRef = await definition(
      context.artifacts,
      id,
      unit,
      'scalar',
      `kernel-v1 ${id}`,
      'mean of per-case native means across the requested cases',
    );
    const value = confirmed
      ? values.reduce((a, b) => a! + b!, 0)! / values.length
      : null;
    return confirmed
      ? {
          definitionRef,
          status: 'available',
          value: { kind: 'scalar', value },
          source: { artifactRef: execution.artifactRef, pointer: '/cases' },
        }
      : {
          definitionRef,
          status: 'unavailable',
          value: null,
          reason: 'Not all cases produced a confirmed mean',
          source: { artifactRef: execution.artifactRef, pointer: '/cases' },
        };
  };
  const unavailableReason = 'Not all cases completed';
  const measurementMetrics: JsonObject = {
    candidateValid: {
      definitionRef: await definition(
        context.artifacts,
        'candidateValid',
        'boolean',
        'scalar',
        'operator completed assessment',
        'all requested cases satisfy the fixed task contract',
      ),
      ...(completed
        ? {
            status: 'available',
            value: { kind: 'scalar', value: valid ? 1 : 0 },
            source: { artifactRef: execution.artifactRef, pointer: '/cases' },
          }
        : {
            status: 'unavailable',
            value: null,
            reason: unavailableReason,
            source: { artifactRef: execution.artifactRef, pointer: '/cases' },
          }),
    },
    latencyMs: {
      definitionRef: await definition(
        context.artifacts,
        'latencyMs',
        'ms',
        'distribution',
        'operator candidateMs',
        'per-case native mean across the requested cases; nearest-rank percentiles',
      ),
      ...(candidateMsValues.length === cases.length
        ? {
            status: 'available',
            value: distribution(candidateMsValues),
            source: { artifactRef: execution.artifactRef, pointer: '/cases' },
          }
        : {
            status: 'unavailable',
            value: null,
            reason: 'Not all cases produced a confirmed native mean',
            source: { artifactRef: execution.artifactRef, pointer: '/cases' },
          }),
    },
    latencyMeanMs: await meanOf(
      'latencyMeanMs',
      'ms',
      cases.map((c) => (c.result.valid === true ? c.result.candidateMs : null)),
    ),
    referenceMeanMs: await meanOf(
      'referenceMeanMs',
      'ms',
      cases.map((c) => (c.result.valid === true ? c.result.referenceMs : null)),
    ),
    speedupVsReference: await meanOf(
      'speedupVsReference',
      'ratio',
      cases.map((c) => (c.result.valid === true ? c.result.speedup : null)),
    ),
  };
  const catalog = {
    schemaVersion: 'rsi.measurement-items/v1',
    items,
  };
  // Preserve the normalized details shape for the existing training-summary reader.
  const profile = await typed(
    context,
    'rsi.operator-sdk-details/v1',
    sdkDetailsSchema,
    {
      mode: 'sdk',
      sourceDigest: execution.sourceDigest,
      caseId: caseIds.join(','),
      caseIds,
      tiling,
      assessment: null,
      profile: null,
    },
  );
  const now = new Date().toISOString();
  const diagnosticsRef = completed
    ? null
    : await context.artifacts.putJson({
        schemaVersion: 'rsi.operator-sdk-diagnostics/v1',
        cases: cases.map((c) => ({
          caseId: c.caseId,
          status: c.result.status,
          cleanup: c.result.cleanup,
          diagnostics: c.result.diagnostics,
        })),
      });
  const measurement = object({
    schemaVersion: 'rsi.measurement/v1',
    ref: 'pending',
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef,
    evaluator: {
      pluginId: 'evaluator.operatorbench',
      implementationDigest: conditionsBase.adapterDigest,
    },
    startedAt: now,
    finishedAt: status === 'unknown' ? null : now,
    status,
    coverage: valid
      ? 'complete'
      : items.some((i) => i.coverage === 'partial')
        ? 'partial'
        : 'none',
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
        runId: cases[0]!.result.runId,
        attemptId: cases[0]!.result.attemptId,
        realNpuRuns: null,
        cleanup: cases.every((c) => c.result.cleanup === 'confirmed')
          ? 'confirmed'
          : 'unknown',
      },
    ),
    metrics: measurementMetrics,
    itemsRef: await context.artifacts.putJson(catalog),
    evidenceIndexRef,
    profile,
    diagnosticsRef,
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
