import { recordSchema } from '../../contracts/models/measurement.js';

const text = { type: 'string', minLength: 1 };
const hashSchema = {
  type: 'string',
  pattern: '^[a-f0-9]{64}$',
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
  sourceBundleDigest: hashSchema,
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
  sourceBundleDigest: hashSchema,
  caseId: text,
  assessment: { type: ['object', 'null'] },
  profile: { type: ['object', 'null'] },
});
