import type { JsonSchema } from '../../contracts/index.js';

export type AgentCodexConfig = {
  executable?: string;
  model?: string;
  thinkingLevel?: string;
  timeoutMs?: number;
  webSearch?: 'disabled' | 'cached' | 'live';
};
export type ResolvedAgentCodexConfig = AgentCodexConfig & {
  executable: string;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'codex' },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    thinkingLevel: { type: 'string', minLength: 1, pattern: '\\S' },
    webSearch: { enum: ['disabled', 'cached', 'live'] },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
