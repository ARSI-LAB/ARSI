import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type ScriptedAgentConfig } from './schema.js';
import { createScriptedAgent } from './service.js';

export { createScriptedAgent };
export type { ScriptedAgentConfig } from './schema.js';

export const scriptedAgentDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  ScriptedAgentConfig
> = {
  id: 'agent.scripted',
  contract: agentContract,
  configSchema,
  create: createScriptedAgent,
};
