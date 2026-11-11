import { defineContract } from '../contract.js';

export type ReleaseInput = {
  candidateRef: string;
  incumbentRef: string;
};

export type ReleaseDecision = 'promote' | 'keep-incumbent' | 'reject';

export type ReleaseOutput = {
  decision: ReleaseDecision;
  reason: string;
  releaseRef: string;
};

/** Final acceptance gate; callers must not route its result back into search. */
export const releaseContract = defineContract({
  id: 'contract.release',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateRef: { minLength: 1, type: 'string' },
      incumbentRef: { minLength: 1, type: 'string' },
    },
    required: ['candidateRef', 'incumbentRef'],
    type: 'object',
  },
  output_schema: {
    additionalProperties: false,
    properties: {
      decision: {
        enum: ['promote', 'keep-incumbent', 'reject'],
      },
      reason: { minLength: 1, type: 'string' },
      releaseRef: { minLength: 1, type: 'string' },
    },
    required: ['decision', 'reason', 'releaseRef'],
    type: 'object',
  },
});
