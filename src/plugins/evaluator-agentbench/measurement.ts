import type {
  RuntimeContext,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import {
  measurementEvidenceSchema,
  measurementItemsSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { digest, object, string, strings } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import {
  nullableObject,
  plain,
  redact,
} from '../shared/evaluator-adapter/data.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import {
  nativeStatus,
  typed,
  readMetrics,
  snapshotOf,
  validateSnapshot,
  archiveItemDetails,
  archiveItemExecution,
  archiveProvenance,
  evaluationStatus,
} from '../shared/evaluator-adapter/measurement.js';
import { conditionsSchema } from '../shared/evaluator-adapter/schemas/index.js';
import { conditions } from './conditions.js';
import { meanReward, successRate } from './metrics.js';
import {
  aggregateTrainingMetrics,
  buildTrainingFeedback,
} from './training-feedback.js';
import { agentbenchProfileSchema } from './measurement-schema.js';

let implementationIdentity: Promise<string> | undefined;
function adapterIdentity(): Promise<string> {
  return (implementationIdentity ??= sourceIdentity(import.meta.url, [
    './index',
    './service',
    './finalized-timeout',
    './preparation-recovery',
    './schema',
    './configuration',
    './conditions',
    './measurement',
    './measurement-schema',
    './metrics',
    './training-feedback',
    '../shared/evaluator-adapter/configuration-schema',
    '../shared/evaluator-adapter/configuration',
    '../shared/evaluator-adapter/data',
    '../shared/evaluator-adapter/sdk',
    '../shared/evaluator-adapter/measurement',
    '../shared/evaluator-adapter/metric',
    '../shared/evaluator-adapter/identity',
    '../shared/evaluator-adapter/schemas/index',
  ]));
}
export async function normalizeEvaluation(
  native: JsonObject,
  input: JsonObject,
  execution: JsonObject,
  resultValue: unknown,
  context: RuntimeContext,
  failure: JsonObject | null = null,
): Promise<string> {
  const result = object(redact(resultValue ?? {}));
  const snapshot = await snapshotOf(result);
  const run = snapshot ? plain(snapshot.run) : {};
  const metricsEnvelope = await readMetrics(result, snapshot);
  const nativeMetrics = metricsEnvelope ? plain(metricsEnvelope.metrics) : {};
  const summary = nullableObject(nativeMetrics['success-rate']);
  if (snapshot) validateSnapshot(snapshot);
  const nativeResultRef = await context.artifacts.putJson({
    result,
    snapshot,
    metrics: metricsEnvelope,
  });
  const snapshotRef = snapshot
    ? await context.artifacts.putJson(snapshot)
    : null;
  const condition = conditions(native, snapshot, execution);
  const comparisonKey =
    condition.known === true ? digest(condition.fixed) : null;
  const records = Array.isArray(snapshot?.records)
    ? snapshot.records.map((v) => object(v))
    : [];
  const taskIds = strings(input.taskIds);
  const actualTaskIds = Array.isArray(run.taskIds) ? strings(run.taskIds) : [];
  if (
    actualTaskIds.length &&
    digest([...actualTaskIds].sort()) !== digest([...taskIds].sort())
  )
    throw new Error('Native SDK task set differs from requested taskIds');
  const attempts = Array.isArray(snapshot?.attemptHistory)
    ? snapshot.attemptHistory
    : [];
  const items: JsonValue[] = [];
  const allEvidence: JsonValue[] = [];
  for (const id of taskIds) {
    const record = records.find((v) => plain(v.key).taskId === id) ?? null;
    const key = record ? plain(record.key) : {};
    const attemptId = typeof key.attemptId === 'string' ? key.attemptId : null;
    const solve = record ? nullableObject(record.solve) : null;
    const details = await archiveItemDetails(
      context,
      id,
      record,
      attempts,
      null,
    );
    const entries = await archiveItemExecution(
      context,
      result,
      id,
      attemptId,
      solve,
    );
    const verifier = entries
      .map((entry) => object(entry))
      .find((entry) => entry.kind === 'verifier');
    const training = await buildTrainingFeedback(
      context.artifacts,
      id,
      record,
      typeof verifier?.artifactRef === 'string' ? verifier.artifactRef : null,
    );
    entries.push({
      id: `${id}/native-result`,
      kind: 'native-result',
      artifactRef: details.artifactRef,
      mediaType: 'application/json',
      sizeBytes: null,
      itemId: id,
      attemptId,
      access: 'private',
      integrity: record ? 'complete' : 'missing',
    });
    const evidence = { schemaVersion: 'rsi.measurement-evidence/v1', entries };
    validate(measurementEvidenceSchema, evidence, 'item evidence');
    const evidenceIndexRef = await context.artifacts.putJson(evidence);
    allEvidence.push(...entries);
    items.push({
      id,
      subject: {
        kind: 'task',
        id,
        parameters: null,
      },
      status: nativeStatus(record?.status, context.signal),
      coverage: record ? 'complete' : 'none',
      comparisonKey,
      metrics: training?.metrics ?? {},
      evaluation: training?.evaluation ?? null,
      evidenceIndexRef,
      details,
    });
  }
  const itemList = { schemaVersion: 'rsi.measurement-items/v1', items };
  validate(measurementItemsSchema, itemList, 'measurement items');
  const itemsRef = await context.artifacts.putJson(itemList);
  allEvidence.push({
    id: 'native-result',
    kind: 'native-result',
    artifactRef: nativeResultRef,
    mediaType: 'application/json',
    sizeBytes: null,
    itemId: null,
    attemptId: null,
    access: 'private',
    integrity: snapshot ? 'complete' : 'missing',
  });
  const evidenceList = {
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries: allEvidence,
  };
  validate(measurementEvidenceSchema, evidenceList, 'measurement evidence');
  const evidenceIndexRef = await context.artifacts.putJson(evidenceList);
  const nativeRun = snapshot
    ? {
        runId: run.runId ?? null,
        status: run.status ?? 'error',
        evaluationKind: run.evaluationKind ?? 'quality',
        taskIds: actualTaskIds,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
      }
    : null;
  const profile = await typed(
    context,
    'measurement.agentbench/v1',
    agentbenchProfileSchema,
    {
      requestedTaskIds: taskIds,
      actualTaskIds,
      run: nativeRun,
      summary,
      snapshotRef,
      reason: snapshot ? null : 'No collected native snapshot',
    },
  );
  const provenance = await archiveProvenance(
    context,
    native,
    result,
    snapshot,
    nativeResultRef,
    metricsEnvelope,
  );
  const found = taskIds.filter((id) =>
    records.some((record) => plain(record.key).taskId === id),
  ).length;
  const status = evaluationStatus(result, context, failure !== null);
  const measurement: JsonObject = {
    schemaVersion: 'rsi.measurement/v1',
    ref: `measurement-${context.callId}`,
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef: string(input.candidateRef),
    evaluator: {
      pluginId: 'evaluator.agentbench',
      implementationDigest: await adapterIdentity(),
    },
    startedAt:
      typeof run.startedAt === 'string'
        ? run.startedAt
        : new Date().toISOString(),
    finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
    status,
    coverage:
      taskIds.length && found === taskIds.length
        ? 'complete'
        : found
          ? 'partial'
          : snapshot
            ? 'none'
            : 'unknown',
    comparisonKey,
    conditions: await typed(
      context,
      'measurement.conditions/v1',
      conditionsSchema,
      condition,
    ),
    provenance,
    metrics: {
      ...(await aggregateTrainingMetrics(
        context.artifacts,
        items.map((v) => object(v)),
        itemsRef,
      )),
      successRate: await successRate(
        context.artifacts,
        summary,
        metricsEnvelope
          ? await context.artifacts.putJson(metricsEnvelope)
          : null,
      ),
      meanReward: await meanReward(
        context.artifacts,
        nullableObject(nativeMetrics['harbor-score']),
        metricsEnvelope
          ? await context.artifacts.putJson(metricsEnvelope)
          : null,
      ),
    },
    itemsRef,
    evidenceIndexRef,
    profile,
    diagnosticsRef: failure ? await context.artifacts.putJson(failure) : null,
    extensions: [],
  };
  validateMeasurement(measurement);
  return context.recordMeasurement(measurement);
}
