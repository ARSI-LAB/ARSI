import { defineContract } from '../contract.js';

export type AgentbenchInput = { candidateRef: string; taskIds: string[] };

export type AgentbenchOutput = { measurementRef: string };

export const agentbenchContract = defineContract({
  id: 'contract.agentbench',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: { minLength: 1, type: 'string' },
      taskIds: {
        items: { minLength: 1, type: 'string' },
        minItems: 1,
        type: 'array',
        uniqueItems: true,
      },
    },
    required: ['candidateRef', 'taskIds'],
    type: 'object',
  },
  output_schema: {
    additionalProperties: false,
    properties: {
      measurementRef: { minLength: 1, type: 'string' },
    },
    required: ['measurementRef'],
    type: 'object',
  },
});
