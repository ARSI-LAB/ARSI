import type {
  OperationDefinition,
  OperationEvents,
  IterativeProposerInput,
  IterativeProposerOutput,
} from '../../contracts/index.js';
import { iterativeProposerContract } from '../../contracts/plugin-types/proposer-iterative.js';
import { configSchema, type OptunaConfig } from './schema.js';
import { createOptunaProposer } from './service.js';
import { checkOptunaDependencies } from './doctor.js';
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

export function optunaProposerEvents(
  events: OperationEvents<OptunaConfig>,
): void {
  events.on('rsi/doctor', checkOptunaDependencies);
}
