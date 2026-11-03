import type {
  AgentbenchInput,
  AgentbenchOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentbenchConfig } from './schema.js';
import { agentbenchContract } from '../../contracts/plugin-types/index.js';
import { createAgentbench } from './service.js';
export const agentbenchDefinition: OperationDefinition<
  AgentbenchInput,
  AgentbenchOutput,
  AgentbenchConfig
> = {
  id: 'evaluator.agentbench',
  description: 'Measure agent instances with the Evaluator SDK AgentBench.',
  contract: agentbenchContract,
  configSchema,
  create: createAgentbench,
};
