import type {
  OperationDefinition,
  SearchInput,
  SearchOutput,
} from '../../contracts/index.js';
import { searchContract } from '../../contracts/plugin-types/search.js';
import { configSchema, type OptunaConfig } from './schema.js';
import { createOptunaProposer } from './service.js';
import { checkOptunaDependencies } from '../../runtime/doctor/business-checks.js';
export const optunaProposerDefinition: OperationDefinition<
  SearchInput,
  SearchOutput,
  OptunaConfig
> = {
  id: 'proposer.optuna',
  description: 'Propose parameter candidates using Optuna optimization.',
  contract: searchContract,
  configSchema,
  create: createOptunaProposer,
  doctor: checkOptunaDependencies,
};
