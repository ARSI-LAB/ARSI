import type { JsonSchema } from '../../contracts/index.js';

export type AgentDshConfig = {
  executable?: string;
  timeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'dsh' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
