import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
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
const aisbenchWorkloadProperties: JsonObject = {
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
};
export const aisbenchWorkloadSchema = {
  oneOf: [
    recordSchema(aisbenchWorkloadProperties),
    recordSchema({
      ...aisbenchWorkloadProperties,
      dataset: { const: 'synthetic' },
      warmups: { type: 'integer', minimum: 0 },
      testType: { const: 'stream' },
      prefixCache: recordSchema({
        ...object(object(aisbenchWorkloadProperties.prefixCache).properties),
        enabled: { const: false },
        warmup: { const: false },
        prefixRatio: { const: 0 },
      }),
    }),
  ],
};
