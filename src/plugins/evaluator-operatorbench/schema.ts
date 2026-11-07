import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import {
  configSchema as evaluatorSchema,
  type EvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';

export type OperatorbenchConfig = EvaluatorConfig & {
  task: { directory: string };
};

export const configSchema: JsonObject = {
  ...evaluatorSchema,
  properties: {
    task: recordSchema({
      directory: { type: 'string', minLength: 1, 'x-rsi-path': 'directory' },
    }),
  },
  required: ['task', 'benchmark'],
};
