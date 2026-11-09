import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type ProposerInput = {
  parent: string;
  goal: string;
  evidenceRefs: string[];
  sources?: { candidateRef: string; measurementRef?: string }[];
  memoryRef?: string | null;
  editConstraints?: JsonObject;
};
export type ProposerOutput =
  | {
      status: 'created';
      candidateRef: string;
      diffRef: string;
      rationale: string;
    }
  | {
      status: 'no-change';
      candidateRef: string;
      diffRef: null;
      rationale: string;
    };

function proposalOutputSchema(
  status: ProposerOutput['status'],
  diffRef: JsonObject,
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'candidateRef', 'diffRef', 'rationale'],
    properties: {
      status: { const: status },
      candidateRef: { type: 'string', minLength: 1 },
      diffRef,
      rationale: { type: 'string' },
    },
  };
}

export const proposerContract = defineContract({
  id: 'contract.proposer',
  input_schema: {
    additionalProperties: false,
    properties: {
      editConstraints: {
        type: 'object',
      },
      evidenceRefs: {
        items: {
          minLength: 1,
          type: 'string',
        },
        type: 'array',
      },
      goal: {
        minLength: 1,
        type: 'string',
      },
      memoryRef: {
        anyOf: [
          {
            minLength: 1,
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
      },
      parent: {
        minLength: 1,
        type: 'string',
      },
      sources: {
        items: {
          additionalProperties: false,
          properties: {
            candidateRef: {
              minLength: 1,
              type: 'string',
            },
            measurementRef: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['candidateRef'],
          type: 'object',
        },
        type: 'array',
      },
    },
    required: ['parent', 'goal', 'evidenceRefs'],
    type: 'object',
  },
  output_schema: {
    oneOf: [
      proposalOutputSchema('created', { type: 'string', minLength: 1 }),
      proposalOutputSchema('no-change', { type: 'null' }),
    ],
  },
});
