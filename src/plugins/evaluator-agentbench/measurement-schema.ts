import { recordSchema } from '../../contracts/models/measurement.js';
import {
  nullable,
  text,
  texts,
  integer,
  number,
  runSchema,
} from '../shared/evaluator-adapter/schemas/index.js';
const successSummarySchema = recordSchema(
  {
    applicable: { type: 'boolean' },
    selected: integer,
    denominator: nullable(integer),
    invalid: integer,
    passed: nullable(integer),
    rate: nullable(number),
    verified: integer,
    pending: integer,
  },
  [
    'selected',
    'denominator',
    'invalid',
    'passed',
    'rate',
    'verified',
    'pending',
  ],
);
export const agentbenchProfileSchema = recordSchema({
  requestedTaskIds: texts,
  actualTaskIds: texts,
  run: nullable(runSchema),
  summary: nullable(successSummarySchema),
  snapshotRef: nullable(text),
  reason: nullable(text),
});
