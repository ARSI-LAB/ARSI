import {
  searchContract,
  type SearchInput,
  type SearchOutput,
} from '../../contracts/plugin-types/search.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { configSchema, type GepaConfig } from './schema.js';
import { createGepaSearch } from './service.js';

export const gepaSearchDefinition: OperationDefinition<
  SearchInput,
  SearchOutput,
  GepaConfig
> = {
  id: 'search.gepa',
  description:
    'Run GEPA reflective prompt evolution with Pareto candidate sampling, ancestry-aware crossover and truthful rollout accounting.',
  contract: searchContract,
  configSchema,
  create: createGepaSearch,
};
