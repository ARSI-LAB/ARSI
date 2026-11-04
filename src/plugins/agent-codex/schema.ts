import type { JsonSchema } from '../../contracts/index.js';

export type AgentCodexConfig = {
  executable?: string;
  model?: string;
  timeoutMs?: number;
};
export type ResolvedAgentCodexConfig = Required<
  Omit<AgentCodexConfig, 'model'>
> &
  Pick<AgentCodexConfig, 'model'>;

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'codex' },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 600000,
    },
  },
};
