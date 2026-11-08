import { defineContract } from '../contract.js';

export type InferencebenchInput = {
  candidateRef: string;
  reportFailedMeasurement?: true;
};

export type InferencebenchOutput = { measurementRef: string };

export const inferencebenchContract = defineContract({
  id: 'contract.inferencebench',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: { minLength: 1, type: 'string' },
      reportFailedMeasurement: { const: true },
    },
    required: ['candidateRef'],
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
