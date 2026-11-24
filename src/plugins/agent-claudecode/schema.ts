import type { JsonSchema } from '../../contracts/index.js';
import {
  agentSandboxSchema,
  type AgentSandboxMode,
} from '../shared/native-agent/sandbox.js';

export type AgentClaudeCodeConfig = {
  executable?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  sandbox?: AgentSandboxMode;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'claude' },
    sandbox: agentSandboxSchema,
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
