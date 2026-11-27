import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type AgentInput = {
  /** Complete user task text, forwarded verbatim by the backend. */
  message: string;
  cwd: string;
  role?: string;
  outputSchema: JsonObject;
};

export type AgentOutput = JsonObject;

export const agentContract = defineContract({
  id: 'contract.agent',
  input_schema: {
    additionalProperties: false,
    properties: {
      cwd: { type: 'string', minLength: 1 },
      role: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
      message: { type: 'string', minLength: 1, pattern: '\\S' },
      outputSchema: { type: 'object' },
    },
    required: ['message', 'cwd', 'outputSchema'],
    type: 'object',
  },
  output_schema: { type: 'object' },
});
