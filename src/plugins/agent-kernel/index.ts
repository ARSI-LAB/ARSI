import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type AgentKernelConfig } from './schema.js';
import { createAgentKernel } from './service.js';

export const kernelDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentKernelConfig
> = {
  id: 'agent.kernel',
  contract: agentContract,
  configSchema,
  create: createAgentKernel,
};
