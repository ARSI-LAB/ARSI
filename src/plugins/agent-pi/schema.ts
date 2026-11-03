import type { JsonSchema } from '../../contracts/index.js';

export type AgentPiConfig = {
  model?: string;
  base_url?: string;
  api_key?: string;
  maxTokens?: number;
  contextWindow?: number;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  retries?: number;
  retryBaseDelayMs?: number;
  timeoutMs?: number;
};

export type ResolvedAgentPiConfig = Required<AgentPiConfig>;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1, default: '${MODEL_NAME}' },
    base_url: { type: 'string', minLength: 1, default: '${MODEL_ENDPOINT}' },
    api_key: {
      type: 'string',
      pattern: '^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$',
      default: '${MODEL_API_KEY}',
    },
    maxTokens: { type: 'integer', minimum: 1, default: 32768 },
    contextWindow: { type: 'integer', minimum: 1, default: 262144 },
    thinkingLevel: {
      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      default: 'low',
    },
    retries: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
    retryBaseDelayMs: {
      type: 'integer',
      minimum: 0,
      maximum: 300000,
      default: 1000,
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 600000,
    },
  },
  additionalProperties: false,
};
