import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import type { OperatorbenchInput } from '../../contracts/plugin-types/operatorbench.js';
import type { KernelExecution } from '../application-kernel/schema.js';
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
import { distribution } from './measurement.js';
import {
  mockConditionsSchema,
  mockProvenanceSchema,
  mockDetailsSchema,
  mockProfileSchema,
} from './schema.js';
import type { OperatorRunRequest, OperatorRunResult } from './runner.js';

/** Nearest-rank percentile in microseconds from millisecond timing samples. */
export function percentileUs(
  samplesMs: number[] | null,
  p: number,
): number | null {
  if (!samplesMs || !samplesMs.length) return null;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! * 1000;
}

/** Correctness-checksum verdict carried by a case record, when present. */
export function checksumMatchOf(record: {
  checks: { id: string; passed: boolean }[];
}): boolean | null {
  const check = record.checks.find((c) => c.id === 'checksum');
  return check === undefined ? null : check.passed;
}

/**
 * Mock-mode measurement: one item per case record plus measurement-level
 * aggregate metrics, mirroring the SDK evaluate record so the policy's
 * latencyMs p50 selection and candidateValid eligibility gate behave
 * identically in fixture-backed smoke runs.
 */
export async function recordMockMeasurement(
  result: OperatorRunResult,
  input: OperatorbenchInput,
  execution: KernelExecution,
  context: RuntimeContext,
  request: OperatorRunRequest,
  tiling: JsonObject | null,
): Promise<string> {
  const rawRef = await context.artifacts.putJson(result);
  const conditions = {
    runnerDigest: request.runnerDigest,
    mode: result.mode,
    taskDigest: result.taskDigest,
    protocolDigest: result.protocolDigest,
    fixtureDigest: request.fixtureDigest,
    caseIds: request.caseIds,
    cases: request.cases,
    protocol: request.protocol,
  };
  const completed =
    result.status === 'completed' && result.cleanup === 'confirmed';
  const valid =
    completed &&
    result.records.length === input.caseIds.length &&
    result.records.every((r) => r.outcome === 'valid');
  const status =
    result.cleanup === 'unknown'
      ? 'unknown'
      : result.status === 'completed'
        ? 'succeeded'
        : result.status;
  const comparisonKey = valid ? digest(conditions) : null;
  // The mapping/aggregation strings stay byte-identical to the SDK evaluate
  // and failed-measurement definitions in measurement.ts/failure.ts so
  // definitionRefs are comparable across measurements and modes.
  const validDefinition = await definition(
    context.artifacts,
    'candidateValid',
    'boolean',
    'scalar',
    'operator completed assessment',
    'all requested cases satisfy the fixed task contract',
  );
  const latencyDefinition = await definition(
    context.artifacts,
    'latencyMs',
    'ms',
    'distribution',
    'operator candidateMs',
    'per-case native mean across the requested cases; nearest-rank percentiles',
  );
  const checksumDefinition = await definition(
    context.artifacts,
    'checksum_match',
    'boolean',
    'scalar',
    'case-checksum',
    '1 when every case matches the reference outputs, else 0; hard gate',
  );
  const metric = (
    definitionRef: string,
    value: JsonObject | null,
    pointer: string,
    reason: string,
  ): JsonObject =>
    value === null
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
          value,
          source: { artifactRef: rawRef, pointer },
        };
  const metrics = (
    isValid: boolean | null,
    samples: number[] | null,
    pointer: string,
    checksum: boolean | null,
  ): JsonObject => ({
    candidateValid: metric(
      validDefinition,
      isValid === null ? null : { kind: 'scalar', value: isValid ? 1 : 0 },
      pointer,
      'Assessment outcome is unconfirmed',
    ),
    latencyMs: metric(
      latencyDefinition,
      isValid && samples?.length ? distribution(samples) : null,
      pointer,
      'Candidate has no valid timing samples',
    ),
    checksum_match: metric(
      checksumDefinition,
      checksum === null ? null : { kind: 'scalar', value: checksum ? 1 : 0 },
      pointer,
      'No case reported a checksum verdict',
    ),
  });
  const entries: JsonObject[] = [
    {
      id: 'native-result',
      kind: 'operator-result',
      artifactRef: rawRef,
      mediaType: 'application/json',
      sizeBytes: null,
      itemId: null,
      attemptId: null,
      access: 'execution',
      integrity: completed ? 'complete' : 'partial',
    },
  ];
  // Compact per-case digest as execution-visible evidence: the evidence
  // projection only exposes final-text/trajectory entries, so without this
  // neither the proposer nor the memory agent can see what a round actually
  // measured (latency, checksum, diagnostics). The candidate's tiling
  // parameters ride along so cross-run memory can attribute results to
  // actual block sizes.
  const digestCases = result.records.map((r) => ({
    id: r.caseId,
    checksumMatch: checksumMatchOf(r),
    p50Us: percentileUs(r.samplesMs, 0.5),
    p99Us: percentileUs(r.samplesMs, 0.99),
    diagnostics: [...r.diagnostics, ...result.diagnostics].map(
      (d) => `${d.code}: ${d.message}`,
    ),
  }));
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
  const index = { schemaVersion: 'rsi.measurement-evidence/v1', entries };
  validate(measurementEvidenceSchema, index);
  const evidenceIndexRef = await context.artifacts.putJson(index);
  const items: JsonObject[] = [];
  for (const [i, record] of result.records.entries()) {
    const pointer = `/records/${i}`;
    const feedback = {
      schemaVersion: 'rsi.evaluation-feedback/v1',
      itemId: record.caseId,
      attemptId: null,
      executionStatus: record.outcome,
      scoreStatus: completed
        ? record.outcome === 'valid'
          ? 'valid'
          : 'invalid'
        : 'unknown',
      passed: completed ? record.outcome === 'valid' : null,
      primaryReward: 'latencyMs',
      passThreshold: null,
      checks: record.checks.map((c, j) => ({
        id: c.id,
        status: c.passed ? 'passed' : 'failed',
        score: c.passed ? 1 : 0,
        reason: null,
        source: { artifactRef: rawRef, pointer: `${pointer}/checks/${j}` },
      })),
      checksComplete: completed && record.outcome === 'valid',
      diagnostics: [...record.diagnostics, ...result.diagnostics]
        .slice(0, 32)
        .map((d) => ({
          kind: 'operator',
          code: d.code,
          message: d.message,
          source: { artifactRef: rawRef, pointer },
          truncated: false,
        })),
      truncated: record.diagnostics.length + result.diagnostics.length > 32,
      source: { artifactRef: rawRef, pointer },
    };
    items.push({
      id: record.caseId,
      subject: { kind: 'operator-case', id: record.caseId, parameters: null },
      status,
      coverage:
        record.outcome === 'valid' && completed
          ? 'complete'
          : record.outcome === 'compile-failed'
            ? 'none'
            : 'partial',
      comparisonKey,
      metrics: metrics(
        completed ? record.outcome === 'valid' : null,
        record.samplesMs,
        pointer,
        checksumMatchOf(record),
      ),
      evaluation: await typed(
        context,
        'rsi.evaluation-feedback/v1',
        evaluationFeedbackSchema,
        feedback,
      ),
      evidenceIndexRef,
      details: await typed(
        context,
        'rsi.operator-details/v1',
        mockDetailsSchema,
        {
          sourceDigest: execution.sourceDigest,
          caseId: record.caseId,
          outcome: record.outcome,
        },
      ),
    });
  }
  const catalog = { schemaVersion: 'rsi.measurement-items/v1', items };
  validate(measurementItemsSchema, catalog);
  const now = new Date().toISOString();
  const measurement: JsonObject = {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'pending',
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef: input.candidateRef,
    evaluator: {
      pluginId: 'evaluator.operatorbench',
      implementationDigest: digest({
        adapter: 'operatorbench/v1',
        mode: result.mode,
        fixtureDigest: request.fixtureDigest,
        runnerDigest: request.runnerDigest,
      }),
    },
    startedAt: now,
    finishedAt: status === 'unknown' ? null : now,
    status,
    coverage: valid
      ? 'complete'
      : result.records.some((r) => r.outcome !== 'compile-failed')
        ? 'partial'
        : 'none',
    comparisonKey,
    conditions: await typed(
      context,
      'rsi.operator-conditions/v1',
      mockConditionsSchema,
      conditions,
    ),
    provenance: await typed(
      context,
      'rsi.operator-provenance/v1',
      mockProvenanceSchema,
      {
        runnerDigest: request.runnerDigest,
        mode: result.mode,
        sourceDigest: execution.sourceDigest,
        artifactRef: execution.artifactRef,
        runId: result.runId,
        realNpuRuns: 0,
        cleanup: result.cleanup,
      },
    ),
    metrics: metrics(
      completed ? valid : null,
      valid ? result.records.flatMap((r) => r.samplesMs ?? []) : null,
      '/records',
      completed
        ? digestCases.every((c) => c.checksumMatch !== false) &&
          digestCases.some((c) => c.checksumMatch !== null)
          ? digestCases.every((c) => c.checksumMatch === true)
          : null
        : null,
    ),
    itemsRef: await context.artifacts.putJson(catalog),
    evidenceIndexRef,
    profile: await typed(
      context,
      'rsi.operator-profile/v1',
      mockProfileSchema,
      {
        mode: result.mode,
        cases: result.records.map((r) => ({
          caseId: r.caseId,
          profile: r.profile,
        })),
      },
    ),
    diagnosticsRef: rawRef,
    extensions: [],
  };
  // These are the same public boundaries used by every evaluator.
  validateMeasurement(object(measurement));
  return context.recordMeasurement(measurement);
}
