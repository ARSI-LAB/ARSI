import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentPiConfig } from './schema.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { createAgentPi } from './service.js';
export const piDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentPiConfig
> = {
  id: 'agent.pi',
  description: 'Execute agent tasks through the Pi coding agent backend.',
  contract: agentContract,
  configSchema,
  create: createAgentPi,
};
