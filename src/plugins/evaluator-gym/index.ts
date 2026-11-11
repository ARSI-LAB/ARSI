import type {
  AgentbenchInput,
  AgentbenchOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentbenchContract } from '../../contracts/plugin-types/index.js';
import { gymConfigSchema, type GymConfig } from './schema.js';
import { createGym } from './service.js';

export const gymDefinition: OperationDefinition<
  AgentbenchInput,
  AgentbenchOutput,
  GymConfig
> = {
  id: 'evaluator.gym',
  description:
    'Measure an AgentBundle on Gym training splits through eval_service.',
  contract: agentbenchContract,
  configSchema: gymConfigSchema,
  create: (config, context) => createGym(config, context, gymConfigSchema),
};
