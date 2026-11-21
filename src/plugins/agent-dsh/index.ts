import { checkDshAgent } from './doctor.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  OperationEvents,
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
  create: createAgentDsh,
};

export function dshEvents(events: OperationEvents<AgentDshConfig>): void {
  events.on('rsi/doctor', checkDshAgent);
}
