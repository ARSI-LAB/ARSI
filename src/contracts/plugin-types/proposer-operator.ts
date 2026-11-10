import { defineContract } from '../contract.js';

/** Policy passes immutable analysis/history references between independent actions. */
export type OperatorProposerInput =
  | {
      action: 'propose';
      phase: 'static';
      entryCandidateRef: string;
      baselineMeasurementRef: string;
      attempt: number;
      goal: string;
      analysisRef: string | null;
      historyRef: string | null;
    }
  | {
      action: 'repair';
      phase: 'static';
      failedCandidateRef: string;
      measurementRef: string;
      analysisRef: string;
      historyRef: string | null;
      attempt: number;
      repairIndex: number;
      goal: string;
    }
  | {
      action: 'propose';
      phase: 'metrics';
      parentCandidateRef: string;
      incumbentMeasurementRef: string;
      diagnosticMeasurementRef: string;
      round: number;
      historyRef: string | null;
      staticHistoryRef: string | null;
      goal: string;
    }
  | {
      action: 'repair';
      phase: 'metrics';
      failedCandidateRef: string;
      measurementRef: string;
      analysisRef: string;
      round: number;
      repairIndex: number;
      historyRef: string | null;
      staticHistoryRef: string | null;
      goal: string;
    };

export type OperatorProposerOutput =
  | {
      action: 'propose';
      status: 'created';
      candidateRef: string;
      analysisRef: string;
      rationale: string;
      diffRef: string;
      reasonCode: 'created';
    }
  | {
      action: 'repair';
      status: 'created';
      candidateRef: string;
      analysisRef: string;
      rationale: string;
      diffRef: string;
      reasonCode: 'created';
    }
  | {
      action: 'propose';
      status: 'no-change';
      candidateRef: string;
      analysisRef: string;
      rationale: string;
      diffRef: null;
      reasonCode: 'no-supported-change' | 'no-static-issues';
    }
  | {
      action: 'repair';
      status: 'no-change';
      candidateRef: string;
      analysisRef: string;
      rationale: string;
      diffRef: null;
      reasonCode: 'no-supported-change';
    }
  | {
      action: 'propose' | 'repair';
      status: 'failed';
      candidateRef: string;
      analysisRef: string;
      rationale: string;
      diffRef: null;
      errorRef: string;
      reasonCode: 'invalid-model-output';
    };

export const operatorProposerContract = defineContract({
  id: 'contract.proposer-operator',
  input_schema: {
    oneOf: [
      {
        type: 'object',
        properties: {
          action: { const: 'propose' },
          phase: { const: 'static' },
          entryCandidateRef: { type: 'string', minLength: 1 },
          baselineMeasurementRef: { type: 'string', minLength: 1 },
          attempt: { type: 'integer', minimum: 1 },
          goal: { type: 'string', minLength: 1 },
          analysisRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
        },
        required: [
          'action',
          'phase',
          'entryCandidateRef',
          'baselineMeasurementRef',
          'attempt',
          'goal',
          'analysisRef',
          'historyRef',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'repair' },
          phase: { const: 'static' },
          failedCandidateRef: { type: 'string', minLength: 1 },
          measurementRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          attempt: { type: 'integer', minimum: 1 },
          repairIndex: { type: 'integer', minimum: 1 },
          goal: { type: 'string', minLength: 1 },
        },
        required: [
          'action',
          'phase',
          'failedCandidateRef',
          'measurementRef',
          'analysisRef',
          'historyRef',
          'attempt',
          'repairIndex',
          'goal',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'propose' },
          phase: { const: 'metrics' },
          parentCandidateRef: { type: 'string', minLength: 1 },
          incumbentMeasurementRef: { type: 'string', minLength: 1 },
          diagnosticMeasurementRef: { type: 'string', minLength: 1 },
          round: { type: 'integer', minimum: 1 },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          staticHistoryRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          goal: { type: 'string', minLength: 1 },
        },
        required: [
          'action',
          'phase',
          'parentCandidateRef',
          'incumbentMeasurementRef',
          'diagnosticMeasurementRef',
          'round',
          'historyRef',
          'staticHistoryRef',
          'goal',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'repair' },
          phase: { const: 'metrics' },
          failedCandidateRef: { type: 'string', minLength: 1 },
          measurementRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          round: { type: 'integer', minimum: 1 },
          repairIndex: { type: 'integer', minimum: 1 },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          staticHistoryRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          goal: { type: 'string', minLength: 1 },
        },
        required: [
          'action',
          'phase',
          'failedCandidateRef',
          'measurementRef',
          'analysisRef',
          'round',
          'repairIndex',
          'historyRef',
          'staticHistoryRef',
          'goal',
        ],
        additionalProperties: false,
      },
    ],
  },
  output_schema: {
    oneOf: [
      {
        type: 'object',
        properties: {
          candidateRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          rationale: { type: 'string' },
          action: { enum: ['propose', 'repair'] },
          status: { const: 'created' },
          diffRef: { type: 'string', minLength: 1 },
          reasonCode: { const: 'created' },
        },
        required: [
          'candidateRef',
          'analysisRef',
          'rationale',
          'action',
          'status',
          'diffRef',
          'reasonCode',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          candidateRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          rationale: { type: 'string' },
          action: { const: 'propose' },
          status: { const: 'no-change' },
          diffRef: { type: 'null' },
          reasonCode: { enum: ['no-supported-change', 'no-static-issues'] },
        },
        required: [
          'candidateRef',
          'analysisRef',
          'rationale',
          'action',
          'status',
          'diffRef',
          'reasonCode',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          candidateRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          rationale: { type: 'string' },
          action: { const: 'repair' },
          status: { const: 'no-change' },
          diffRef: { type: 'null' },
          reasonCode: { const: 'no-supported-change' },
        },
        required: [
          'candidateRef',
          'analysisRef',
          'rationale',
          'action',
          'status',
          'diffRef',
          'reasonCode',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          candidateRef: { type: 'string', minLength: 1 },
          analysisRef: { type: 'string', minLength: 1 },
          rationale: { type: 'string' },
          action: { enum: ['propose', 'repair'] },
          status: { const: 'failed' },
          diffRef: { type: 'null' },
          errorRef: { type: 'string', minLength: 1 },
          reasonCode: { const: 'invalid-model-output' },
        },
        required: [
          'candidateRef',
          'analysisRef',
          'rationale',
          'action',
          'status',
          'diffRef',
          'errorRef',
          'reasonCode',
        ],
        additionalProperties: false,
      },
    ],
  },
});
