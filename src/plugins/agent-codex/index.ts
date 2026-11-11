import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type AgentCodexConfig } from './schema.js';
import { createAgentCodex } from './service.js';
import { checkCodexAgent } from './doctor.js';

export const codexDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentCodexConfig
> = {
  id: 'agent.codex',
  description: 'Execute agent tasks through the Codex backend.',
  contract: agentContract,
  configSchema,
  create: createAgentCodex,
  doctor: checkCodexAgent,
};
