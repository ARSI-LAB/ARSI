import {
  iterativeProposerContract,
  type IterativeProposerInput,
  type IterativeProposerOutput,
} from '../../contracts/plugin-types/proposer-iterative.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { configSchema, type PopulationConfig } from './schema.js';
import { createPopulationProposer } from './service.js';

export const populationProposerDefinition: OperationDefinition<
  IterativeProposerInput,
  IterativeProposerOutput,
  PopulationConfig
> = {
  id: 'proposer.population',
  description:
    'Maintain a prompt candidate population with Pareto parent sampling, mutation proposals and ancestry-aware crossover.',
  contract: iterativeProposerContract,
  configSchema,
  create: createPopulationProposer,
};
