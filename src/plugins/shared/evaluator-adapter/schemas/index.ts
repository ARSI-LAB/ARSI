import type { JsonObject } from '../../../../contracts/index.js';
import { recordSchema } from '../../../../contracts/models/measurement.js';
import { configSchema } from '../configuration.js';
export const text: JsonObject = { type: 'string' };
export const nullable = (schema: JsonObject): JsonObject => ({
  anyOf: [schema, { type: 'null' }],
});
export const texts: JsonObject = { type: 'array', items: text };
export const number: JsonObject = { type: 'number' };
export const integer: JsonObject = { type: 'integer', minimum: 0 };
// Public Evaluator contracts deliberately reserve JSON data for benchmark-owned payloads.
const jsonData: JsonObject = {
  type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
};
const stringMap: JsonObject = { type: 'object', additionalProperties: text };
export const sourceSchema = recordSchema({
  source: text,
  revision: text,
  files: {
    type: 'array',
    items: recordSchema({ path: text, sha256: text, origin: text }),
  },
  metadata: jsonData,
});
const identitySchema = recordSchema({
  evaluator: recordSchema({ name: text, version: text }),
  runtime: recordSchema({ node: text, platform: text, arch: text }),
});
const runtimeCondition = recordSchema({
  kind: nullable(text),
  platform: nullable(text),
  arch: nullable(text),
  baseImage: jsonData,
  runtimes: {
    type: 'array',
    items: recordSchema({ name: nullable(text), version: nullable(text) }),
  },
  resources: jsonData,
});
// SDK configuration is stored as JSON; its fields and validation belong to the SDK.
export const conditionsSchema = recordSchema({
  protocol: { const: 1 },
  kind: { enum: ['agentbench', 'inferencebench'] },
  known: { type: 'boolean' },
  reasons: texts,
  fixed: recordSchema({
    config: nullable(configSchema),
    source: nullable(sourceSchema),
    identity: nullable(identitySchema),
    solver: nullable(stringMap),
    taskIds: texts,
    serviceResources: jsonData,
    environments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: nullable(runtimeCondition),
      },
    },
  }),
  candidateFactors: texts,
});
export const provenanceSchema = recordSchema({
  nativeResult: recordSchema({
    kind: nullable(text),
    exitCode: nullable(integer),
    runId: nullable(text),
    jobId: nullable(text),
    resultRef: text,
  }),
  snapshotDigest: nullable(text),
  runIdentity: nullable(identitySchema),
  solverProvenance: nullable(stringMap),
  source: nullable(sourceSchema),
  configuration: nullable(configSchema),
  collectedAt: text,
  metricsRevision: nullable(integer),
  usageKnown: { type: 'boolean' },
});
export const runSchema = recordSchema({
  runId: text,
  status: { enum: ['running', 'completed', 'cancelled', 'error'] },
  evaluationKind: { enum: ['quality', 'performance'] },
  taskIds: texts,
  startedAt: nullable(text),
  finishedAt: nullable(text),
});
const attemptKeySchema = recordSchema({
  runId: text,
  taskId: text,
  attemptId: text,
});
const selectedSchema = recordSchema({
  key: attemptKeySchema,
  status: text,
  executionStatus: nullable(text),
  scoreStatus: nullable(text),
  cleanupStatus: nullable(text),
  recordRef: text,
  solveRef: nullable(text),
  verdictRef: nullable(text),
});
export const agentxWorkloadSchema = recordSchema(
  {
    schemaVersion: { const: 1 },
    kind: { const: 'agentx' },
    variant: { enum: ['256k', 'full'] },
    mode: { enum: ['standard', 'smoke', 'replay'] },
    concurrency: { type: 'integer', minimum: 1 },
    durationSeconds: { type: 'integer', minimum: 1 },
    seed: { type: 'integer' },
    dataset: text,
    loader: text,
    revision: text,
    sha256: text,
    tracePath: { const: 'input/traces.jsonl' },
    traceCount: { type: 'integer', minimum: 1 },
  },
  [
    'schemaVersion',
    'kind',
    'variant',
    'mode',
    'concurrency',
    'durationSeconds',
    'seed',
    'dataset',
    'loader',
    'revision',
    'sha256',
    'tracePath',
  ],
);
const statisticSchema = recordSchema({
  unit: text,
  mean: nullable(number),
  p50: nullable(number),
  p95: nullable(number),
  p99: nullable(number),
  count: nullable(integer),
});
const statisticMap: JsonObject = {
  type: 'object',
  additionalProperties: nullable(statisticSchema),
};
export const agentxSummarySchema = recordSchema(
  {
    schemaVersion: { const: 1 },
    kind: { const: 'agentx' },
    harnessVersion: text,
    workload: agentxWorkloadSchema,
    lexicon: recordSchema({ source: text, revision: text, digest: text }),
    profiling: statisticMap,
    warmup: statisticMap,
    upstreamSubmissionValid: { type: ['boolean', 'null'] },
    upstreamInvalidReasons: texts,
    comparable: { type: 'boolean' },
    incomparableReasons: texts,
    replayCoverage: recordSchema({
      schemaVersion: { const: 1 },
      selectedTraces: integer,
      completedTraces: integer,
      expectedRequests: integer,
      observedRequests: integer,
      successfulRequests: integer,
      failedRequests: integer,
      cancelledRequests: integer,
      missingRequests: integer,
      duplicateRequests: integer,
      unexpectedRequests: integer,
      complete: { type: 'boolean' },
    }),
    telemetry: jsonData,
  },
  [
    'schemaVersion',
    'kind',
    'harnessVersion',
    'workload',
    'lexicon',
    'profiling',
    'warmup',
    'upstreamSubmissionValid',
    'upstreamInvalidReasons',
    'comparable',
    'incomparableReasons',
  ],
);
export const itemDetailsSchema = recordSchema({
  selected: nullable(selectedSchema),
  attempts: {
    type: 'array',
    items: recordSchema({
      key: attemptKeySchema,
      ordinal: { type: 'integer', minimum: 1 },
      recordRef: nullable(text),
    }),
  },
  summary: nullable(agentxSummarySchema),
});
