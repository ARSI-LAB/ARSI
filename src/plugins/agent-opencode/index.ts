import { checkOpenCodeAgent } from './doctor.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type AgentOpenCodeConfig } from './schema.js';
import { createAgentOpenCode } from './service.js';

export const openCodeDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentOpenCodeConfig
> = {
  id: 'agent.opencode',
  description: 'Execute agent tasks through the OpenCode backend.',
  contract: agentContract,
  configSchema,
  doctor: checkOpenCodeAgent,
  create: createAgentOpenCode,
};
