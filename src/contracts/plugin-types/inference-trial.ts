import { defineContract } from '../contract.js';
import { recordSchema } from '../models/measurement.js';

export type InferenceTrialInput = {
  candidateRef: string;
  evaluatorRef: string;
  deduplicate?: { parameterFile: string; candidateRefs: string[] };
};
export type InferenceTrialOutput =
  | { status: 'measured'; measurementRef: string; reason: null }
  | { status: 'duplicate'; measurementRef: null; reason: string }
  | {
      status: 'startup-failed' | 'invalid-measurement';
      measurementRef: string | null;
      reason: string;
    };

const ref = { type: 'string', minLength: 1 };
export const inferenceTrialContract = defineContract({
  id: 'contract.inference-trial',
  input_schema: recordSchema(
    {
      candidateRef: ref,
      evaluatorRef: ref,
      deduplicate: recordSchema({
        parameterFile: ref,
        candidateRefs: { type: 'array', items: ref },
      }),
    },
    ['candidateRef', 'evaluatorRef'],
  ),
  output_schema: {
    oneOf: [
      recordSchema({
        status: { const: 'measured' },
        measurementRef: ref,
        reason: { type: 'null' },
      }),
      recordSchema({
        status: { const: 'duplicate' },
        measurementRef: { type: 'null' },
        reason: ref,
      }),
      recordSchema({
        status: { enum: ['startup-failed', 'invalid-measurement'] },
        measurementRef: { anyOf: [ref, { type: 'null' }] },
        reason: ref,
      }),
    ],
  },
});
