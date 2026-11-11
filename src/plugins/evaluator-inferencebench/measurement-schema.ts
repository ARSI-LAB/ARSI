import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import {
  nullable,
  text,
  texts,
  sourceSchema,
  runSchema,
} from '../shared/evaluator-adapter/schemas/index.js';
export const inferenceProfileSchema = recordSchema({
  run: nullable(runSchema),
  source: nullable(sourceSchema),
  pointIds: texts,
  snapshotRef: nullable(text),
  reason: nullable(text),
});

const positiveInteger: JsonObject = { type: 'integer', minimum: 1 };
export const aisbenchWorkloadSchema = recordSchema({
  inputLength: positiveInteger,
  outputLength: positiveInteger,
  dataCount: positiveInteger,
  concurrency: positiveInteger,
  requestRate: { type: 'number', minimum: 0 },
  testType: { enum: ['stream', 'text'] },
  prefixCache: recordSchema({
    enabled: { type: 'boolean' },
    prefixCount: positiveInteger,
    prefixRatio: { type: 'number', minimum: 0, maximum: 1 },
    warmup: { type: 'boolean' },
    dp: positiveInteger,
    seed: { type: 'integer', minimum: 0 },
  }),
});
