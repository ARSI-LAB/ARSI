import {
  iterativeProposerContract,
  type IterativeProposerInput,
  type IterativeProposerOutput,
} from '../../contracts/plugin-types/proposer-iterative.js';
import type { OperationDefinition } from '../../contracts/index.js';
import { checkParetoEvolutionProposer } from './doctor.js';
import { configSchema, type ParetoEvolutionConfig } from './schema.js';
import { createParetoEvolutionProposer } from './service.js';

export const paretoEvolutionProposerDefinition: OperationDefinition<
  IterativeProposerInput,
  IterativeProposerOutput,
  ParetoEvolutionConfig
> = {
  id: 'proposer.pareto-evolution',
  description:
    'Maintain a prompt candidate population with Pareto parent sampling, mutation proposals and ancestry-aware crossover.',
  contract: iterativeProposerContract,
  configSchema,
  create: createParetoEvolutionProposer,
  doctor: checkParetoEvolutionProposer,
};
