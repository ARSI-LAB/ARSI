import { checkClaudeCodeAgent } from './doctor.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type AgentClaudeCodeConfig } from './schema.js';
import { createAgentClaudeCode } from './service.js';

export const claudeCodeDefinition: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentClaudeCodeConfig
> = {
  id: 'agent.claudecode',
  description: 'Execute agent tasks through the Claude Code backend.',
  contract: agentContract,
  configSchema,
  doctor: checkClaudeCodeAgent,
  create: createAgentClaudeCode,
};
