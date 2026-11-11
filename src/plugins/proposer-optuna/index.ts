import type {
  OperationDefinition,
  IterativeProposerInput,
  IterativeProposerOutput,
} from '../../contracts/index.js';
import { iterativeProposerContract } from '../../contracts/plugin-types/proposer-iterative.js';
import { configSchema, type OptunaConfig } from './schema.js';
import { createOptunaProposer } from './service.js';
export const optunaProposerDefinition: OperationDefinition<
  IterativeProposerInput,
  IterativeProposerOutput,
  OptunaConfig
> = {
  id: 'proposer.optuna',
  description: 'Propose parameter candidates using Optuna optimization.',
  contract: iterativeProposerContract,
  configSchema,
  create: createOptunaProposer,
};
