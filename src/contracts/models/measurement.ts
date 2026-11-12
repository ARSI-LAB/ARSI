import type { JsonObject, JsonSchema } from '../json.js';
import { digest } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
export type MeasurementStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type CoverageStatus = 'complete' | 'partial' | 'none' | 'unknown';
export interface TypedArtifact extends JsonObject {
  schemaId: string;
  schemaDigest: string;
  artifactRef: string;
}
export interface Measurement extends JsonObject {
  schemaVersion: 'rsi.measurement/v1';
  ref: string;
  experimentId: string;
  callId: string;
  candidateRef: string;
  evaluator: { pluginId: string; implementationDigest: string };
  startedAt: string;
  finishedAt: string | null;
  status: MeasurementStatus;
  coverage: CoverageStatus;
  comparisonKey: string | null;
  conditions: TypedArtifact;
  provenance: TypedArtifact;
  metrics: JsonObject;
  itemsRef: string;
  evidenceIndexRef: string;
  profile: TypedArtifact;
  diagnosticsRef: string | null;
  extensions: TypedArtifact[];
}
const text: JsonObject = { type: 'string', minLength: 1 };
const nullableText: JsonObject = { anyOf: [text, { type: 'null' }] };
const nonnegative: JsonObject = { type: 'integer', minimum: 0 };
const optionalNumber: JsonObject = { type: ['number', 'null'] };
export function recordSchema(
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject {
  return { type: 'object', properties, required, additionalProperties: false };
}
export const typedArtifactSchema = recordSchema({
  schemaId: text,
  schemaDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  artifactRef: text,
});
/** Evaluator-owned public context for version-aware proposal research. */
export const environmentSummarySchema = recordSchema({
  software: { type: ['string', 'null'] },
  devices: { anyOf: [{ type: 'array', items: text }, { type: 'null' }] },
  resourcesVerified: { type: 'boolean' },
  workload: {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  },
  benchmark: nullableText,
  identity: {
    anyOf: [
      recordSchema({
        evaluator: recordSchema({ name: text, version: text }),
        runtime: recordSchema({ node: text, platform: text, arch: text }),
      }),
      { type: 'null' },
    ],
  },
});

const sourceSchema = recordSchema({
  artifactRef: text,
  pointer: { type: 'string' },
});
const valueSchema: JsonObject = {
  oneOf: [
    recordSchema({ kind: { const: 'scalar' }, value: { type: 'number' } }),
    {
      ...recordSchema({
        kind: { const: 'distribution' },
        count: { anyOf: [nonnegative, { type: 'null' }] },
        mean: optionalNumber,
        p50: optionalNumber,
        p95: optionalNumber,
        p99: optionalNumber,
      }),
      anyOf: ['mean', 'p50', 'p95', 'p99'].map((key) => ({
        properties: { [key]: { type: 'number' } },
      })),
    },
  ],
};
export const metricSchema: JsonObject = {
  oneOf: [
    recordSchema({
      definitionRef: text,
      status: { const: 'available' },
      value: valueSchema,
      source: sourceSchema,
    }),
    recordSchema({
      definitionRef: text,
      status: { const: 'unavailable' },
      value: { type: 'null' },
      reason: text,
      source: { anyOf: [sourceSchema, { type: 'null' }] },
    }),
  ],
};
const metricMap: JsonObject = {
  type: 'object',
  additionalProperties: metricSchema,
};
const statusSchema: JsonObject = {
  enum: ['succeeded', 'failed', 'cancelled', 'unknown'],
};
const coverageSchema: JsonObject = {
  enum: ['complete', 'partial', 'none', 'unknown'],
};
export const measurementSchema: JsonSchema = recordSchema({
  schemaVersion: { const: 'rsi.measurement/v1' },
  ref: text,
  experimentId: text,
  callId: text,
  candidateRef: text,
  evaluator: recordSchema({ pluginId: text, implementationDigest: text }),
  startedAt: text,
  finishedAt: nullableText,
  status: statusSchema,
  coverage: coverageSchema,
  comparisonKey: nullableText,
  conditions: typedArtifactSchema,
  provenance: typedArtifactSchema,
  metrics: metricMap,
  itemsRef: text,
  evidenceIndexRef: text,
  profile: typedArtifactSchema,
  diagnosticsRef: nullableText,
  extensions: { type: 'array', items: typedArtifactSchema },
});
export const measurementItemSchema = recordSchema({
  id: text,
  subject: recordSchema({
    kind: text,
    id: text,
    parameters: { anyOf: [typedArtifactSchema, { type: 'null' }] },
  }),
  status: statusSchema,
  coverage: coverageSchema,
  comparisonKey: nullableText,
  metrics: metricMap,
  evaluation: { anyOf: [typedArtifactSchema, { type: 'null' }] },
  evidenceIndexRef: text,
  details: typedArtifactSchema,
});
const feedbackSource = recordSchema({
  artifactRef: text,
  pointer: { type: 'string' },
});
export const evaluationFeedbackSchema = recordSchema({
  schemaVersion: { const: 'rsi.evaluation-feedback/v1' },
  itemId: text,
  attemptId: nullableText,
  executionStatus: text,
  scoreStatus: {
    enum: ['valid', 'invalid', 'pending', 'not-applicable', 'unknown'],
  },
  passed: { type: ['boolean', 'null'] },
  primaryReward: nullableText,
  passThreshold: optionalNumber,
  checks: {
    type: 'array',
    maxItems: 100,
    items: recordSchema({
      id: text,
      status: text,
      score: optionalNumber,
      reason: { type: ['string', 'null'] },
      source: feedbackSource,
    }),
  },
  checksComplete: { type: ['boolean', 'null'] },
  diagnostics: {
    type: 'array',
    maxItems: 32,
    items: recordSchema({
      kind: text,
      code: nullableText,
      message: { type: 'string' },
      source: feedbackSource,
      truncated: { type: 'boolean' },
    }),
  },
  truncated: { type: 'boolean' },
  source: feedbackSource,
});
export const measurementItemsSchema = recordSchema({
  schemaVersion: { const: 'rsi.measurement-items/v1' },
  items: { type: 'array', items: measurementItemSchema },
});
export const evidenceEntrySchema = recordSchema({
  id: text,
  kind: text,
  artifactRef: nullableText,
  mediaType: text,
  sizeBytes: { anyOf: [nonnegative, { type: 'null' }] },
  itemId: nullableText,
  attemptId: nullableText,
  access: { enum: ['execution', 'delivery', 'private'] },
  integrity: { enum: ['complete', 'partial', 'missing', 'not-produced'] },
});
export const measurementEvidenceSchema = recordSchema({
  schemaVersion: { const: 'rsi.measurement-evidence/v1' },
  entries: { type: 'array', items: evidenceEntrySchema },
});
export const metricDefinitionSchema = recordSchema({
  id: text,
  description: text,
  unit: text,
  valueKind: { enum: ['scalar', 'distribution'] },
  version: { const: 1 },
  aggregation: text,
  mapping: text,
});
export function typedArtifact(
  schemaId: string,
  schema: JsonSchema,
  artifactRef: string,
): TypedArtifact {
  return { schemaId, schemaDigest: digest(schema), artifactRef };
}
export function validateMeasurement(
  value: unknown,
): asserts value is Measurement {
  validate(measurementSchema, value, 'Measurement');
}
