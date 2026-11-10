import type {
  InferencebenchInput,
  InferencebenchOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type EvaluatorConfig } from './schema.js';
import { inferencebenchContract } from '../../contracts/plugin-types/index.js';
import { createInferencebench } from './service.js';
export const inferencebenchDefinition: OperationDefinition<
  InferencebenchInput,
  InferencebenchOutput,
  EvaluatorConfig
> = {
  id: 'evaluator.inferencebench',
  description:
    'Measure inference instances with the Evaluator SDK InferenceBench.',
  contract: inferencebenchContract,
  configSchema,
  create: createInferencebench,
};
