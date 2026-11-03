import { recordSchema } from '../../contracts/models/measurement.js';
import {
  nullable,
  text,
  texts,
  sourceSchema,
  runSchema,
} from '../shared/evaluator-adapter/schemas/index.js';
export const agentxProfileSchema = recordSchema({
  run: nullable(runSchema),
  source: nullable(sourceSchema),
  pointIds: texts,
  snapshotRef: nullable(text),
  reason: nullable(text),
});
