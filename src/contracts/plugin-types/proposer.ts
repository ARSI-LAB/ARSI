import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type ProposerInput = {
  parent: string;
  goal: string;
  evidenceRefs: string[];
  sources?: { candidateRef: string; measurementRef?: string }[];
  memoryRef?: string | null;
  editConstraints?: JsonObject;
  /** Previous proposal and selection observations supplied by the Policy. */
  observations?: JsonObject | null;
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
      observations: { type: ['object', 'null'] },
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
      {
        additionalProperties: false,
        properties: {
          candidateRef: {
            minLength: 1,
            type: 'string',
          },
          diffRef: {
            minLength: 1,
            type: 'string',
          },
          rationale: {
            type: 'string',
          },
          status: {
            const: 'created',
          },
        },
        required: ['status', 'candidateRef', 'diffRef', 'rationale'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          candidateRef: {
            minLength: 1,
            type: 'string',
          },
          diffRef: {
            type: 'null',
          },
          rationale: {
            type: 'string',
          },
          status: {
            const: 'no-change',
          },
        },
        required: ['status', 'candidateRef', 'diffRef', 'rationale'],
        type: 'object',
      },
    ],
  },
});
