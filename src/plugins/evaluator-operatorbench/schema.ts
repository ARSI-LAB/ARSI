import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import type { EvaluatorConfig } from '../shared/evaluator-adapter/configuration.js';

export type OperatorbenchConfig = EvaluatorConfig & {
  task: { directory: string };
};

export const operatorbenchConfigSchema: JsonObject = {
  type: 'object',
  properties: {
    task: recordSchema({
      directory: { type: 'string', minLength: 1, 'x-rsi-path': 'directory' },
    }),
  },
  required: ['task', 'benchmark'],
};
