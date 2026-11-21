import { checkOpenCodeAgent } from './doctor.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  OperationEvents,
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
  create: createAgentOpenCode,
};

export function openCodeEvents(
  events: OperationEvents<AgentOpenCodeConfig>,
): void {
  events.on('rsi/doctor', checkOpenCodeAgent);
}
