import type { JsonObject, JsonValue } from '../json.js';
import { defineContract } from '../contract.js';

export type AgentInput = {
  goal: string;
  prompt: string;
  input?: JsonValue;
  files?: Record<string, string>;
  outputSchema: JsonObject;
  agentRef?: string;
  /** Request-attempt limit for backends that own the transport. Native Codex sessions cannot enforce it. */
  maxModelCalls?: number;
};

export type AgentOutput = JsonObject;

export const agentContract = defineContract({
  id: 'contract.agent',
  input_schema: {
    additionalProperties: false,
    properties: {
      agentRef: { type: 'string' },
      files: { additionalProperties: { type: 'string' }, type: 'object' },
      goal: { type: 'string' },
      input: {},
      maxModelCalls: { minimum: 1, type: 'integer' },
      outputSchema: { type: 'object' },
      prompt: { type: 'string' },
    },
    required: ['goal', 'prompt', 'outputSchema'],
    type: 'object',
  },
  output_schema: { type: 'object' },
});
