import { checkDshAgent } from './doctor.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type AgentDshConfig } from './schema.js';
import { createAgentDsh } from './service.js';

export const dshDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentDshConfig
> = {
  id: 'agent.dsh',
  description: 'Execute agent tasks through the native DSH CLI.',
  contract: agentContract,
  configSchema,
  doctor: checkDshAgent,
  create: createAgentDsh,
};
