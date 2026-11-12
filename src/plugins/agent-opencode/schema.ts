import type { JsonSchema } from '../../contracts/index.js';

export type AgentOpenCodeConfig = {
  executable?: string;
  model?: string;
  timeoutMs?: number;
};
export type ResolvedAgentOpenCodeConfig = AgentOpenCodeConfig & {
  executable: string;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'opencode' },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
