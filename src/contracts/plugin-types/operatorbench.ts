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
  | { action: 'evaluate'; measurementRef: string }
  | {
      action: 'profile';
      measurementRef: string;
      collectionStatus: 'completed' | 'unavailable';
    };

export const operatorbenchContract = defineContract({
  id: 'contract.operatorbench',
  input_schema: {
    oneOf: ['evaluate', 'profile'].map((action) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        candidateRef: { type: 'string', minLength: 1 },
        caseIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
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
          : {}),
      },
      required: [
        'action',
        'measurementRef',
        ...(action === 'profile' ? ['collectionStatus'] : []),
      ],
    })),
  },
});
