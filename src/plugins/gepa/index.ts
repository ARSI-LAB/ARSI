import {
  gepaOptimizerContract,
  type GepaOptimizerInput,
  type GepaOptimizerOutput,
} from '../../contracts/plugin-types/gepa.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { configSchema } from './schema.js';
import { createGepaOptimizer } from './service.js';

export const gepaOptimizerDefinition: OperationDefinition<
  GepaOptimizerInput,
  GepaOptimizerOutput
> = {
  id: 'gepa.optimizer',
  description:
    'Run GEPA reflective prompt evolution with Pareto candidate sampling, ancestry-aware crossover and truthful rollout accounting.',
  contract: gepaOptimizerContract,
  configSchema,
  create: createGepaOptimizer,
};

export * from './engine.js';
export { createGepaOptimizer } from './service.js';
