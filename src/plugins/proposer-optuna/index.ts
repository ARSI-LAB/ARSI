import type {
  OperationDefinition,
  ParameterSearchInput,
  ParameterSearchOutput,
} from '../../contracts/index.js';
import { parameterSearchProposerContract } from '../../contracts/plugin-types/proposer-parameter-search.js';
import { configSchema, type OptunaConfig } from './schema.js';
import { createOptunaProposer } from './service.js';
export const optunaProposerDefinition: OperationDefinition<
  ParameterSearchInput,
  ParameterSearchOutput,
  OptunaConfig
> = {
  id: 'proposer.optuna',
  description: 'Propose parameter candidates using Optuna optimization.',
  contract: parameterSearchProposerContract,
  configSchema,
  create: createOptunaProposer,
};
