import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type AgentInput = {
  goal: string;
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
      goal: { type: 'string' },
      outputSchema: { type: 'object' },
    },
    required: ['goal', 'cwd', 'outputSchema'],
    type: 'object',
  },
  output_schema: { type: 'object' },
});
