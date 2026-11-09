import type {
  JsonObject,
  JsonSchema,
  RuntimeContext,
} from '../../contracts/index.js';
import type { OperatorbenchInput } from '../../contracts/plugin-types/operatorbench.js';
import {
  typedArtifact,
  measurementItemsSchema,
  measurementEvidenceSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import { validate } from '../../shared/schema.js';
import type { OperatorbenchOutput } from '../../contracts/plugin-types/operatorbench.js';

/**
 * A candidate the Application lifecycle could not prepare (e.g. the precheck
 * rejected the kernel) is an evaluation outcome, not a runner crash: record a
 * failed measurement so the policy loop counts a stale round and converges
 * instead of dying mid-run with a non-resumable receipt. No instance was
 * acquired, so source identity fields stay null and coverage is 'none'.
 */
export type FailedMeasurementDescriptor = {
  schemaId: string;
  schema: JsonSchema;
  value: JsonObject;
};

/**
 * A rejected acquire resolves with unverified resources plus the rejection
 * detail (the manager aborts the run on any failed acquire call, so the
 * rejection must reach the evaluator as a resolved execution). The evaluator
 * turns it into a failed measurement rather than comparing an unverifiable
 * candidate.
 */
export function rejectionMessage(raw: JsonObject): string | null {
  const resources = raw.resources;
  if (
    !(
      resources !== null &&
      typeof resources === 'object' &&
      !Array.isArray(resources) &&
      (resources as JsonObject).verified === false
    )
  )
    return null;
  const rejection = raw.rejection;
  const detail =
    rejection !== null &&
    typeof rejection === 'object' &&
    !Array.isArray(rejection)
      ? (rejection as JsonObject)
      : null;
  const message =
    detail && typeof detail.message === 'string'
      ? `: ${detail.message}`
      : ' (no rejection detail)';
  const logPath =
    detail && typeof detail.logPath === 'string'
      ? `; log: ${detail.logPath}`
      : '';
  return `Kernel candidate precheck rejected${message}${logPath}`;
}

export async function recordFailedMeasurement(
  input: OperatorbenchInput,
  context: RuntimeContext,
  meta: {
    message: string;
    caseIds: string[];
    runnerDigest: string;
    conditions: FailedMeasurementDescriptor;
    provenance: FailedMeasurementDescriptor;
    profile: FailedMeasurementDescriptor;
    tiling: JsonObject | null;
  },
): Promise<OperatorbenchOutput> {
  const rawRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.operator-acquisition-failure/v1',
    message: meta.message,
    caseIds: meta.caseIds,
    diagnostics: [{ code: 'ACQUISITION_FAILED', message: meta.message }],
  });
  const typed = async (
    id: string,
    schema: JsonSchema,
    value: JsonObject,
  ): Promise<JsonObject> => {
    validate(schema, value, id);
    return typedArtifact(id, schema, await context.artifacts.putJson(value));
  };
  // The mapping/aggregation strings must stay byte-identical to the
  // successful-evaluate definitions in measurement.ts so definitionRefs are
  // comparable across measurements.
  const unavailable = async (
    id: string,
    unit: string,
    mapping: string,
    aggregation: string,
  ): Promise<JsonObject> => ({
    definitionRef: await definition(
      context.artifacts,
      id,
      unit,
      'scalar',
      mapping,
      aggregation,
    ),
    status: 'unavailable',
    value: null,
    reason: 'The candidate was never acquired for evaluation',
    source: { artifactRef: rawRef, pointer: '/message' },
  });
  const metrics: JsonObject = {
    candidateValid: await unavailable(
      'candidateValid',
      'boolean',
      'operator completed assessment',
      'all requested cases satisfy the fixed task contract',
    ),
    latencyMs: await unavailable(
      'latencyMs',
      'ms',
      'operator candidateMs',
      'per-case native mean across the requested cases; nearest-rank percentiles',
    ),
    checksum_match: await unavailable(
      'checksum_match',
      'boolean',
      'case-checksum',
      '1 when every case matches the reference outputs, else 0; hard gate',
    ),
  };
  const digestValue = {
    schemaVersion: 'rsi.operatorbench-digest/v1',
    tiling: meta.tiling,
    allCompleted: false,
    checksumMatch: null,
    cases: meta.caseIds.map((id) => ({
      id,
      checksumMatch: null,
      p50Us: null,
      p99Us: null,
      diagnostics: [meta.message],
    })),
  };
  const digestText = JSON.stringify(digestValue, null, 2);
  const entries = [
    {
      id: 'native-result',
      kind: 'operator-result',
      artifactRef: rawRef,
      mediaType: 'application/json',
      sizeBytes: null,
      itemId: null,
      attemptId: null,
      access: 'execution',
      integrity: 'missing',
    },
    {
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
      integrity: 'missing',
    },
  ];
  const evidence = { schemaVersion: 'rsi.measurement-evidence/v1', entries };
  validate(measurementEvidenceSchema, evidence, 'measurement evidence');
  const now = new Date().toISOString();
  const measurement: JsonObject = {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'pending',
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef: input.candidateRef,
    evaluator: {
      pluginId: 'evaluator.operatorbench',
      implementationDigest: meta.runnerDigest,
    },
    startedAt: now,
    finishedAt: now,
    status: 'failed',
    coverage: 'none',
    comparisonKey: null,
    conditions: await typed(
      meta.conditions.schemaId,
      meta.conditions.schema,
      meta.conditions.value,
    ),
    provenance: await typed(
      meta.provenance.schemaId,
      meta.provenance.schema,
      meta.provenance.value,
    ),
    metrics,
    itemsRef: await context.artifacts.putJson({
      schemaVersion: 'rsi.measurement-items/v1',
      items: [],
    }),
    evidenceIndexRef: await context.artifacts.putJson(evidence),
    profile: await typed(
      meta.profile.schemaId,
      meta.profile.schema,
      meta.profile.value,
    ),
    diagnosticsRef: rawRef,
    extensions: [],
  };
  validate(measurementItemsSchema, {
    schemaVersion: 'rsi.measurement-items/v1',
    items: [],
  });
  validateMeasurement(measurement);
  const ref = await context.recordMeasurement(measurement);
  return { action: 'evaluate', measurementRef: ref, status: 'failed' };
}
