import type { JsonObject } from '../../contracts/index.js';
import type { BoundServiceConfig } from '../shared/evaluator-adapter/configuration.js';
import { recordSchema } from '../../contracts/models/measurement.js';

const text: JsonObject = { type: 'string', minLength: 1 };
export const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^[a-f0-9]{64}$',
};
/** Kernel replay supplies the SDK service and rejects it in Recipe input. */
export type OperatorbenchConfig = BoundServiceConfig & {
  task: { directory: string };
};
export const configSchema: JsonObject = {
  type: 'object',
  properties: {
    task: recordSchema({ directory: { ...text, 'x-rsi-path': 'directory' } }),
  },
  required: ['task', 'benchmark'],
};
export const sdkConditionsSchema = recordSchema({
  mode: { const: 'sdk' },
  taskDigest: hashSchema,
  adapterDigest: hashSchema,
  sdkBuildDigest: hashSchema,
  evaluation: { type: ['object', 'null'] },
});
export const sdkProvenanceSchema = recordSchema({
  mode: { const: 'sdk' },
  sourceDigest: hashSchema,
  artifactRef: text,
  runId: { type: ['string', 'null'] },
  attemptId: { type: ['string', 'null'] },
  realNpuRuns: { type: 'null' },
  cleanup: { enum: ['confirmed', 'unknown'] },
});
export const sdkDetailsSchema = recordSchema({
  mode: { const: 'sdk' },
  operation: { enum: ['evaluate', 'profile'] },
  sourceDigest: hashSchema,
  caseId: text,
  assessment: { type: ['object', 'null'] },
  profile: { type: ['object', 'null'] },
});
