import { defineContract } from '../contract.js';

/** Retry policy for retryable evaluator infrastructure failures; attempts include the first run. */
export type OperatorbenchRetry = { maxAttempts: number; backoffMs: number };
/** A preflight-derived tolerance pair supplied by the policy for frozen evaluation. */
export type OperatorbenchToleranceInput = {
  mode: 'explicit' | 'dtype' | 'frozen';
  rtol: number;
  atol: number;
  safetyFactor?: number;
};
export type OperatorbenchTolerance = {
  mode: 'explicit' | 'dtype' | 'observed' | 'frozen';
  rtol: number;
  atol: number;
  source: string;
  observedMaxAbs?: number;
};
export type OperatorbenchPreflightDiagnostic = {
  dtype: string | null;
  errorStats: Record<string, number> | null;
  suggestedTolerance: OperatorbenchToleranceInput;
};
export type OperatorbenchInput =
  | {
      action: 'evaluate';
      candidateRef: string;
      caseIds: string[];
      tolerance?: OperatorbenchToleranceInput | null;
      infraRetry?: OperatorbenchRetry;
    }
  | {
      action: 'profile';
      candidateRef: string;
      caseIds: string[];
      assessmentMeasurementRef: string;
      infraRetry?: OperatorbenchRetry;
    }
  | {
      action: 'preflight';
      candidateRef: string;
      caseIds: string[];
      infraRetry?: OperatorbenchRetry;
    };
export type OperatorbenchOutput =
  | { action: 'evaluate'; measurementRef: string }
  | {
      action: 'profile';
      measurementRef: string;
      collectionStatus: 'completed' | 'unavailable';
    }
  | {
      action: 'preflight';
      measurementRef: string;
      evaluationStatus: 'completed' | 'infrastructure-error';
      valid: boolean;
      tolerance: OperatorbenchTolerance | null;
      frozenTolerance: OperatorbenchToleranceInput | null;
      errorStats: Record<string, number> | null;
      attempts: number;
      suggestedTolerance: OperatorbenchToleranceInput | null;
      diagnostic: OperatorbenchPreflightDiagnostic | null;
    };
const retrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxAttempts: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
    backoffMs: { type: 'integer', minimum: 0, maximum: 60000, default: 1000 },
  },
  required: ['maxAttempts', 'backoffMs'],
};
const toleranceInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { enum: ['explicit', 'dtype', 'frozen'] },
    rtol: { type: 'number', minimum: 0 },
    atol: { type: 'number', minimum: 0 },
    safetyFactor: { type: 'number', exclusiveMinimum: 0 },
  },
  required: ['mode', 'rtol', 'atol'],
};
const toleranceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { enum: ['explicit', 'dtype', 'observed', 'frozen'] },
    rtol: { type: 'number', minimum: 0 },
    atol: { type: 'number', minimum: 0 },
    source: { type: 'string', minLength: 1 },
    observedMaxAbs: { type: 'number', minimum: 0 },
  },
  required: ['mode', 'rtol', 'atol', 'source'],
};
const errorStatsSchema = {
  type: ['object', 'null'],
  additionalProperties: { type: 'number', minimum: 0 },
};
const diagnosticSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        dtype: { type: ['string', 'null'], minLength: 1 },
        errorStats: errorStatsSchema,
        suggestedTolerance: toleranceInputSchema,
      },
      required: ['dtype', 'errorStats', 'suggestedTolerance'],
    },
  ],
};
const retry = { infraRetry: retrySchema };
export const operatorbenchContract = defineContract({
  id: 'contract.operatorbench',
  input_schema: {
    oneOf: ['evaluate', 'preflight', 'profile'].map((action) => ({
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
        ...retry,
        ...(action === 'profile'
          ? { assessmentMeasurementRef: { type: 'string', minLength: 1 } }
          : {}),
        ...(action === 'evaluate'
          ? { tolerance: { anyOf: [toleranceInputSchema, { type: 'null' }] } }
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
    oneOf: ['evaluate', 'preflight', 'profile'].map((action) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: action },
        measurementRef: { type: 'string', minLength: 1 },
        ...(action === 'profile'
          ? { collectionStatus: { enum: ['completed', 'unavailable'] } }
          : {}),
        ...(action === 'preflight'
          ? {
              evaluationStatus: {
                enum: ['completed', 'infrastructure-error'],
              },
              valid: { type: 'boolean' },
              tolerance: { anyOf: [toleranceSchema, { type: 'null' }] },
              frozenTolerance: {
                anyOf: [toleranceInputSchema, { type: 'null' }],
              },
              errorStats: errorStatsSchema,
              attempts: { type: 'integer', minimum: 1, maximum: 10 },
              suggestedTolerance: {
                anyOf: [toleranceInputSchema, { type: 'null' }],
              },
              diagnostic: diagnosticSchema,
            }
          : {}),
      },
      required: [
        'action',
        'measurementRef',
        ...(action === 'profile' ? ['collectionStatus'] : []),
        ...(action === 'preflight'
          ? [
              'evaluationStatus',
              'valid',
              'tolerance',
              'frozenTolerance',
              'errorStats',
              'attempts',
              'suggestedTolerance',
              'diagnostic',
            ]
          : []),
      ],
    })),
  },
});
