import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  evaluationFeedbackSchema,
  measurementEvidenceSchema,
  measurementItemsSchema,
  recordSchema,
  type Measurement,
  validateMeasurement,
} from '../../contracts/index.js';
import { digest } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { typed } from '../shared/evaluator-adapter/measurement.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import type { GymEvalOutcome } from './client.js';
import type { GymConfig } from './schema.js';

let implementationIdentity: Promise<string> | undefined;
function adapterIdentity(): Promise<string> {
  return (implementationIdentity ??= sourceIdentity(import.meta.url, [
    './index',
    './service',
    './activation',
    './client',
    './measurement',
    './submission',
    './schema',
  ]));
}

const text = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [text, { type: 'null' }] } as JsonObject;
const jsonData = {
  type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
} as JsonObject;

const identitySchema: JsonObject = recordSchema({
  evaluator: recordSchema({ name: text, version: text }),
  runtime: recordSchema({ node: text, platform: text, arch: text }),
});

const conditionsSchema: JsonObject = recordSchema({
  protocol: { const: 1 },
  kind: { const: 'gym' },
  known: { type: 'boolean' },
  reasons: { type: 'array', items: text },
  fixed: recordSchema({
    config: jsonData,
    source: { type: 'null' },
    identity: identitySchema,
    solver: { type: 'null' },
    taskIds: { type: 'array', items: text },
    serviceResources: recordSchema({ baseUrl: text }),
    environments: { type: 'array', items: { type: 'object' } },
  }),
  candidateFactors: { type: 'array', items: text },
});

const provenanceSchema: JsonObject = recordSchema({
  nativeResult: recordSchema({
    kind: { const: 'gym-eval' },
    exitCode: { type: ['integer', 'null'] },
    runId: nullableText,
    jobId: nullableText,
    resultRef: text,
  }),
  snapshotDigest: { type: 'null' },
  runIdentity: identitySchema,
  solverProvenance: { type: 'null' },
  source: { type: 'null' },
  configuration: recordSchema({
    baseUrl: text,
    requestDefaults: { type: 'object' },
  }),
  collectedAt: text,
  metricsRevision: { type: 'null' },
  usageKnown: { type: 'boolean' },
});

const gymProfileSchema: JsonObject = recordSchema({
  evalId: nullableText,
  benchmark: text,
  split: text,
  tier: text,
  seed: { type: 'integer' },
  status: text,
  requestedTaskIds: { type: 'array', items: text },
  rewardMean: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  passRate: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  rollouts: { type: 'integer', minimum: 0 },
  rolloutsFailed: { type: 'integer', minimum: 0 },
  trusted: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
  environmentDigest: nullableText,
  harnessManifestDigest: nullableText,
  evaluationDigest: nullableText,
  perRolloutRef: nullableText,
  warnings: { type: 'array', items: text },
  failureReason: nullableText,
});

const gymItemSchema: JsonObject = recordSchema({
  evalId: nullableText,
  taskId: text,
  status: text,
  perRolloutRef: nullableText,
  rewardMean: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  passRate: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  rollouts: { type: 'integer', minimum: 0 },
  rolloutsFailed: { type: 'integer', minimum: 0 },
  truncated: { type: 'boolean' },
});

export interface GymMeasurementInput {
  candidateRef: string;
  bundleDigest: string;
  baseUrl: string;
  config: GymConfig;
  taskIds: string[];
  outcome: GymEvalOutcome | null;
  failure: JsonObject | null;
  startedAt: string;
}

export interface GymMeasurementResult {
  measurementRef: string;
  status: Measurement['status'];
  comparable: boolean;
  reason: string | null;
}

export async function recordGymMeasurement(
  context: RuntimeContext,
  input: GymMeasurementInput,
): Promise<GymMeasurementResult> {
  const { outcome, config, failure } = input;
  const request = config.requestDefaults;
  const taskIds = [...input.taskIds];
  const finishedAt = new Date().toISOString();
  const identity = {
    evaluator: {
      name: 'gym-eval-service',
      version: outcome?.experimentProfileId ?? 'unknown',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const reasons = conditionReasons(outcome);
  const known = reasons.length === 0;
  const nativeResultRef = await context.artifacts.putJson({
    outcome,
    failure,
    candidateDigest: input.bundleDigest,
  });
  const comparisonKey =
    known && outcome !== null
      ? digest({
          adapter: request.adapter,
          benchmark: request.benchmark,
          split: request.split,
          tier: request.tier,
          seed: request.seed,
          taskIds: [...taskIds].sort(),
          harnessManifestDigest: outcome.harnessManifestDigest,
          environmentDigest: outcome.environmentDigest,
          datasetVersion: outcome.datasetVersion,
          experimentProfileId: outcome.experimentProfileId,
        })
      : null;
  const status = measurementStatus(outcome, failure);
  const coverage = measurementCoverage(outcome, taskIds.length);
  const source = { artifactRef: nativeResultRef, pointer: '/outcome/metrics' };
  const definitions = await Promise.all([
    definition(
      context.artifacts,
      'meanReward',
      'score',
      'scalar',
      'gym.metrics.reward_mean',
      'native Gym mean over successful rollouts; failures are reported separately',
    ),
    definition(
      context.artifacts,
      'successRate',
      'ratio',
      'scalar',
      'gym.metrics.pass_rate',
      'native Gym pass rate over executed rollouts',
    ),
    definition(
      context.artifacts,
      'rollouts',
      'count',
      'scalar',
      'gym.metrics.rollouts',
      'native Gym rollout count',
    ),
    definition(
      context.artifacts,
      'rolloutsFailed',
      'count',
      'scalar',
      'gym.metrics.rollouts_failed',
      'native Gym infrastructure-failure sidecar count',
    ),
  ]);
  const metrics: JsonObject = {
    meanReward: scalarMetric(
      definitions[0]!,
      outcome?.rewardMean ?? null,
      source,
      'Gym reported no reward mean',
    ),
    successRate: scalarMetric(
      definitions[1]!,
      outcome?.passRate ?? null,
      source,
      'Gym reported no pass rate',
    ),
    rollouts: scalarMetric(
      definitions[2]!,
      outcome?.rollouts ?? null,
      source,
      'Gym reported no rollout count',
    ),
    rolloutsFailed: scalarMetric(
      definitions[3]!,
      outcome?.rolloutsFailed ?? null,
      source,
      'Gym reported no failed rollout count',
    ),
  };
  const evidence = [
    {
      id: 'native-result',
      kind: 'native-result',
      artifactRef: nativeResultRef,
      mediaType: 'application/json',
      sizeBytes: null,
      itemId: null,
      attemptId: null,
      access: 'private' as const,
      integrity:
        outcome === null ? ('missing' as const) : ('complete' as const),
    },
  ];
  const items: JsonValue[] = [];
  const nativeItems = outcome?.items ?? [];
  if (taskIds.length && outcome !== null && outcome.rollouts > 0) {
    for (const taskId of taskIds) {
      const nativeItemIndex = nativeItems.findIndex(
        (item) => item.taskId === taskId,
      );
      const nativeItem =
        nativeItemIndex >= 0 ? nativeItems[nativeItemIndex]! : null;
      const evaluation =
        nativeItem === null
          ? null
          : await typed(
              context,
              'rsi.evaluation-feedback/v1',
              evaluationFeedbackSchema,
              {
                schemaVersion: 'rsi.evaluation-feedback/v1',
                itemId: taskId,
                attemptId: null,
                executionStatus: outcome.status,
                scoreStatus:
                  nativeItem.rewardMean === null ? 'unknown' : 'valid',
                passed:
                  nativeItem.passRate === null
                    ? null
                    : nativeItem.passRate >= 1,
                primaryReward: 'reward',
                passThreshold: 1,
                checks: nativeItem.checks.map((check, index) => ({
                  id: check.id,
                  status: check.status,
                  score: check.score,
                  reason: check.reason,
                  source: {
                    artifactRef: nativeResultRef,
                    pointer: `/outcome/items/${nativeItemIndex}/checks/${index}`,
                  },
                })),
                checksComplete: nativeItem.rollouts > 0,
                diagnostics: nativeItem.diagnostics.map(
                  (diagnostic, index) => ({
                    kind: diagnostic.kind,
                    code: diagnostic.code,
                    message: diagnostic.message,
                    source: {
                      artifactRef: nativeResultRef,
                      pointer: `/outcome/items/${nativeItemIndex}/diagnostics/${index}`,
                    },
                    truncated: diagnostic.truncated,
                  }),
                ),
                truncated: nativeItem.truncated,
                source: {
                  artifactRef: nativeResultRef,
                  pointer: `/outcome/items/${nativeItemIndex}`,
                },
              },
            );
      const details = await typed(
        context,
        'measurement.gym/item/v1',
        gymItemSchema,
        {
          evalId: outcome.evalId,
          taskId,
          status: outcome.status,
          perRolloutRef: outcome.perRolloutRef,
          rewardMean: nativeItem?.rewardMean ?? null,
          passRate: nativeItem?.passRate ?? null,
          rollouts: nativeItem?.rollouts ?? 0,
          rolloutsFailed: nativeItem?.rolloutsFailed ?? 0,
          truncated: nativeItem?.truncated ?? false,
        },
      );
      const itemEvidence = {
        schemaVersion: 'rsi.measurement-evidence/v1',
        entries: [
          {
            id: `${taskId}/native-result`,
            kind: 'native-result',
            artifactRef: nativeResultRef,
            mediaType: 'application/json',
            sizeBytes: null,
            itemId: taskId,
            attemptId: null,
            access: 'private',
            integrity: 'partial',
          },
        ],
      };
      validate(measurementEvidenceSchema, itemEvidence, 'item evidence');
      items.push({
        id: taskId,
        subject: { kind: 'task', id: taskId, parameters: null },
        status,
        coverage,
        comparisonKey,
        metrics: {},
        evaluation,
        evidenceIndexRef: await context.artifacts.putJson(itemEvidence),
        details,
      });
    }
  }
  const itemList = { schemaVersion: 'rsi.measurement-items/v1', items };
  validate(measurementItemsSchema, itemList, 'measurement items');
  const itemsRef = await context.artifacts.putJson(itemList);
  const evidenceList = {
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries: evidence,
  };
  validate(measurementEvidenceSchema, evidenceList, 'measurement evidence');
  const evidenceIndexRef = await context.artifacts.putJson(evidenceList);
  const condition = {
    protocol: 1,
    kind: 'gym',
    known,
    reasons,
    fixed: {
      config: {
        adapter: request.adapter,
        benchmark: request.benchmark,
        split: request.split,
        tier: request.tier,
        seed: request.seed,
        tasks: taskIds,
        harnessManifest: request.harnessManifest ?? null,
      },
      source: null,
      identity,
      solver: null,
      taskIds,
      serviceResources: { baseUrl: input.baseUrl },
      environments: [],
    },
    candidateFactors: ['candidateRef', 'bundleDigest'],
  };
  const provenance = {
    nativeResult: {
      kind: 'gym-eval',
      exitCode: null,
      runId: outcome?.evalId ?? null,
      jobId: null,
      resultRef: nativeResultRef,
    },
    snapshotDigest: null,
    runIdentity: identity,
    solverProvenance: null,
    source: null,
    configuration: { baseUrl: input.baseUrl, requestDefaults: request },
    collectedAt: finishedAt,
    metricsRevision: null,
    usageKnown: outcome !== null,
  };
  const diagnostic =
    failure !== null
      ? failure
      : outcome !== null && outcome.errorCode !== null
        ? {
            code: outcome.errorCode,
            message: outcome.errorMessage,
            fixHint: outcome.errorFixHint,
          }
        : null;
  const measurement: JsonObject = {
    schemaVersion: 'rsi.measurement/v1',
    ref: `measurement-${context.callId}`,
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef: input.candidateRef,
    evaluator: {
      pluginId: 'evaluator.gym',
      implementationDigest: await adapterIdentity(),
    },
    startedAt: input.startedAt,
    finishedAt,
    status,
    coverage,
    comparisonKey,
    conditions: await typed(
      context,
      'measurement.conditions/v1',
      conditionsSchema,
      condition,
    ),
    provenance: await typed(
      context,
      'measurement.provenance/v1',
      provenanceSchema,
      provenance,
    ),
    metrics,
    itemsRef,
    evidenceIndexRef,
    profile: await typed(context, 'measurement.gym/v1', gymProfileSchema, {
      evalId: outcome?.evalId ?? null,
      benchmark: request.benchmark,
      split: request.split,
      tier: request.tier,
      seed: request.seed,
      status: outcome?.status ?? 'unknown',
      requestedTaskIds: taskIds,
      rewardMean: outcome?.rewardMean ?? null,
      passRate: outcome?.passRate ?? null,
      rollouts: outcome?.rollouts ?? 0,
      rolloutsFailed: outcome?.rolloutsFailed ?? 0,
      trusted: outcome?.trusted ?? null,
      environmentDigest: outcome?.environmentDigest ?? null,
      harnessManifestDigest: outcome?.harnessManifestDigest ?? null,
      evaluationDigest: outcome?.evaluationDigest ?? null,
      perRolloutRef: outcome?.perRolloutRef ?? null,
      warnings: [...(outcome?.warnings ?? [])],
      failureReason: known ? null : reasons.join('; '),
    }),
    diagnosticsRef:
      diagnostic === null ? null : await context.artifacts.putJson(diagnostic),
    extensions: [],
  };
  validateMeasurement(measurement);
  const measurementRef = await context.recordMeasurement(measurement);
  const comparable =
    status === 'succeeded' && coverage === 'complete' && comparisonKey !== null;
  return {
    measurementRef,
    status,
    comparable,
    reason: comparableReason(outcome, failure, comparisonKey, coverage, status),
  };
}

function conditionReasons(outcome: GymEvalOutcome | null): string[] {
  if (outcome === null) return ['No Gym result was recorded'];
  const reasons: string[] = [];
  if (outcome.status !== 'completed')
    reasons.push(`Gym status is ${outcome.status}`);
  if (outcome.trusted === false)
    reasons.push('Gym marked the result untrusted (overfit guard)');
  if (outcome.environmentDigest === null)
    reasons.push('Gym reported no environment digest');
  if (outcome.harnessManifestDigest === null)
    reasons.push('Gym reported no harness manifest digest');
  if (outcome.datasetVersion === null)
    reasons.push('Gym reported no dataset version');
  if (outcome.experimentProfileId === null)
    reasons.push('Gym reported no experiment profile identity');
  return reasons;
}

function scalarMetric(
  definitionRef: string,
  value: number | null,
  source: { artifactRef: string; pointer: string },
  reason: string,
): JsonObject {
  if (value === null)
    return {
      definitionRef,
      status: 'unavailable',
      value: null,
      reason,
      source: null,
    };
  return {
    definitionRef,
    status: 'available',
    value: { kind: 'scalar', value },
    source,
  };
}

function measurementStatus(
  outcome: GymEvalOutcome | null,
  failure: JsonObject | null,
): Measurement['status'] {
  if (failure !== null || outcome === null) return 'failed';
  if (outcome.status === 'completed' && outcome.trusted !== false)
    return 'succeeded';
  if (outcome.status === 'failed' || outcome.status === 'budget_exhausted')
    return 'failed';
  return 'unknown';
}

function measurementCoverage(
  outcome: GymEvalOutcome | null,
  expected: number,
): Measurement['coverage'] {
  if (outcome === null) return 'unknown';
  if (outcome.rollouts === 0) return 'none';
  if (outcome.rolloutsFailed > 0) return 'partial';
  if (expected > 0 && outcome.rollouts < expected) return 'partial';
  return 'complete';
}

function comparableReason(
  outcome: GymEvalOutcome | null,
  failure: JsonObject | null,
  comparisonKey: string | null,
  coverage: Measurement['coverage'],
  status: Measurement['status'],
): string | null {
  if (failure !== null) return 'Gym evaluation failed before a usable result';
  if (outcome === null) return 'No Gym result was recorded';
  if (outcome.trusted === false)
    return 'Gym marked the result untrusted (overfit guard)';
  if (status !== 'succeeded') return `Gym result status is ${outcome.status}`;
  if (comparisonKey === null) return 'Conditions are not fully known';
  if (coverage !== 'complete') return 'Rollout coverage is incomplete';
  return null;
}
