import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type ParameterSearchInput =
  | { action: 'initialize'; parent: string }
  | { action: 'suggest'; stateRef: string }
  | {
      action: 'observe';
      stateRef: string;
      trialId: string;
      measurementRef: string;
      decisionRef: string;
    };
export type ParameterSearchOutput =
  | { action: 'initialize'; stateRef: string }
  | {
      action: 'suggest';
      status: 'candidate';
      stateRef: string;
      trialId: string;
      candidateRef: string;
      parameters: JsonObject;
    }
  | {
      action: 'suggest';
      status: 'stopped';
      stateRef: string;
      reason: 'search-exhausted' | 'sampling-limit';
    }
  | { action: 'observe'; stateRef: string };
const ref = { type: 'string', minLength: 1 };
const shape = (properties: JsonObject) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
export const parameterSearchProposerContract = defineContract({
  id: 'contract.proposer-parameter-search',
  input_schema: {
    oneOf: [
      shape({ action: { const: 'initialize' }, parent: ref }),
      shape({ action: { const: 'suggest' }, stateRef: ref }),
      shape({
        action: { const: 'observe' },
        stateRef: ref,
        trialId: ref,
        measurementRef: ref,
        decisionRef: ref,
      }),
    ],
  },
  output_schema: {
    oneOf: [
      shape({ action: { const: 'initialize' }, stateRef: ref }),
      shape({
        action: { const: 'suggest' },
        status: { const: 'candidate' },
        stateRef: ref,
        trialId: ref,
        candidateRef: ref,
        parameters: { type: 'object' },
      }),
      shape({
        action: { const: 'suggest' },
        status: { const: 'stopped' },
        stateRef: ref,
        reason: { enum: ['search-exhausted', 'sampling-limit'] },
      }),
      shape({ action: { const: 'observe' }, stateRef: ref }),
    ],
  },
});
