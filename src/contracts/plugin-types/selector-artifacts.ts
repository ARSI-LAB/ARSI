import { defineContract } from '../contract.js';

export type ArtifactSelectorInput = {
  candidates: { candidateRef: string; measurementRef: string }[];
  rubric: string;
};
export type ArtifactSelectorOutput = {
  candidateRef: string;
  measurementRef: string;
  decisionRef: string;
};

export const artifactSelectorContract = defineContract({
  id: 'contract.selector-artifacts',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidates: {
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
          required: ['candidateRef', 'measurementRef'],
          type: 'object',
        },
        minItems: 1,
        type: 'array',
      },
      rubric: {
        minLength: 1,
        type: 'string',
      },
    },
    required: ['candidates', 'rubric'],
    type: 'object',
  },
  output_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: {
        minLength: 1,
        type: 'string',
      },
      decisionRef: {
        minLength: 1,
        type: 'string',
      },
      measurementRef: {
        minLength: 1,
        type: 'string',
      },
    },
    required: ['candidateRef', 'measurementRef', 'decisionRef'],
    type: 'object',
  },
});
