import {
  searchContract,
  type SearchInput,
  type SearchOutput,
} from '../../contracts/plugin-types/search.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { configSchema, type GepaConfig } from './schema.js';
import { createPromptEvolutionSearch } from './service.js';

export const promptEvolutionSearchDefinition: OperationDefinition<
  SearchInput,
  SearchOutput,
  GepaConfig
> = {
  id: 'search.prompt-evolution',
  description:
    'Evolve modular prompts through reflective proposals, Pareto candidate sampling and ancestry-aware crossover.',
  contract: searchContract,
  configSchema,
  create: createPromptEvolutionSearch,
};
