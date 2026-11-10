import type { JsonSchema } from '../../contracts/index.js';

export type AgentClaudeCodeConfig = {
  executable?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
};
export type ResolvedAgentClaudeCodeConfig = AgentClaudeCodeConfig & {
  executable: string;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'claude' },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
