import type {
  InferencebenchInput,
  InferencebenchOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type InferencebenchConfig } from './schema.js';
import { inferencebenchContract } from '../../contracts/plugin-types/index.js';
import { createInferencebench } from './service.js';
export const inferencebenchDefinition: OperationDefinition<
  InferencebenchInput,
  InferencebenchOutput,
  InferencebenchConfig
> = {
  id: 'evaluator.inferencebench',
  description:
    'Measure inference instances with the Evaluator SDK InferenceBench.',
  contract: inferencebenchContract,
  configSchema,
  create: createInferencebench,
};
