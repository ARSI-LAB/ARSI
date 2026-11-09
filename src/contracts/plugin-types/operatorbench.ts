import { defineContract } from '../contract.js';

export type OperatorbenchInput =
  | { action: 'evaluate'; candidateRef: string; caseIds: string[] }
  | {
      action: 'profile';
      candidateRef: string;
      caseIds: string[];
      assessmentMeasurementRef: string;
    };
export type OperatorbenchOutput =
  | {
      action: 'evaluate';
      measurementRef: string;
      /** Mirrors the recorded measurement status so a policy can tell
       * "evaluated and rejected" from "not evaluable" (e.g. the lifecycle
       * precheck rejected the candidate) without re-reading the measurement. */
      status?: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
    }
  | {
      action: 'profile';
      measurementRef: string;
      collectionStatus: 'completed' | 'unavailable';
    };
const properties = {
  candidateRef: { type: 'string', minLength: 1 },
  caseIds: {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { type: 'string', minLength: 1 },
  },
};
export const operatorbenchContract = defineContract({
  id: 'contract.operatorbench',
  input_schema: {
    oneOf: ['evaluate', 'profile'].map((action) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        ...properties,
        action: { const: action },
        ...(action === 'profile'
          ? { assessmentMeasurementRef: { type: 'string', minLength: 1 } }
          : {}),
      },
      required: [
        'action',
        'candidateRef',
        'caseIds',
        ...(action === 'profile' ? ['assessmentMeasurementRef'] : []),
      ],
    })),
  },
  output_schema: {
    oneOf: ['evaluate', 'profile'].map((action) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: action },
        measurementRef: { type: 'string', minLength: 1 },
        ...(action === 'profile'
          ? { collectionStatus: { enum: ['completed', 'unavailable'] } }
          : {
              status: {
                enum: ['succeeded', 'failed', 'unknown', 'cancelled'],
              },
            }),
      },
      required: [
        'action',
        'measurementRef',
        ...(action === 'profile' ? ['collectionStatus'] : []),
      ],
    })),
  },
});
