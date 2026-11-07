import {
  populationSearchContract,
  type PopulationSearchInput,
  type PopulationSearchOutput,
} from '../../contracts/plugin-types/population-search.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { configSchema, type GepaConfig } from './schema.js';
import { createGepaSearch } from './service.js';

export const gepaSearchDefinition: OperationDefinition<
  PopulationSearchInput,
  PopulationSearchOutput,
  GepaConfig
> = {
  id: 'search.gepa',
  description:
    'Run GEPA reflective prompt evolution with Pareto candidate sampling, ancestry-aware crossover and truthful rollout accounting.',
  contract: populationSearchContract,
  configSchema,
  create: createGepaSearch,
};
