import { defineContract } from '../contract.js';
import {
  operatorProposerContract,
  type OperatorProposerOutput,
} from './proposer-operator.js';

export const operatorAttemptOutcomes = [
  'adopted',
  'verified-no-gain',
  'verification-failed',
  'no-change',
  'proposal-failed',
] as const;
export type OperatorAttemptOutcome = (typeof operatorAttemptOutcomes)[number];

export type OperatorSummarizerInput =
  | {
      phase: 'static';
      entryCandidateRef: string;
      attempt: number;
      action: 'summarize';
      analysisRef: string;
      historyRef: string | null;
      actions: OperatorProposerOutput[];
      candidateRefs: string[];
      measurementRefs: string[];
      decisionRef: string | null;
      outcome: OperatorAttemptOutcome;
    }
  | {
      phase: 'metrics';
      parentCandidateRef: string;
      incumbentMeasurementRef: string;
      round: number;
      candidateDiagnosticMeasurementRef: string | null;
      action: 'summarize';
      analysisRef: string;
      historyRef: string | null;
      actions: OperatorProposerOutput[];
      candidateRefs: string[];
      measurementRefs: string[];
      decisionRef: string | null;
      outcome: OperatorAttemptOutcome;
    };

export type OperatorSummarizerOutput = {
  action: 'summarize';
  historyRef: string;
  summaryRef: string;
};

export const operatorSummarizerContract = defineContract({
  id: 'contract.summarizer-operator',
  input_schema: {
    oneOf: [
      {
        type: 'object',
        properties: {
          action: { const: 'summarize' },
          analysisRef: { type: 'string', minLength: 1 },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          actions: {
            type: 'array',
            minItems: 1,
            items: operatorProposerContract.output_schema,
          },
          measurementRefs: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          decisionRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          outcome: { enum: [...operatorAttemptOutcomes] },
          phase: { const: 'static' },
          entryCandidateRef: { type: 'string', minLength: 1 },
          attempt: { type: 'integer', minimum: 1 },
          candidateRefs: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
        required: [
          'action',
          'analysisRef',
          'historyRef',
          'actions',
          'measurementRefs',
          'decisionRef',
          'outcome',
          'phase',
          'entryCandidateRef',
          'attempt',
          'candidateRefs',
        ],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'summarize' },
          analysisRef: { type: 'string', minLength: 1 },
          historyRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          actions: {
            type: 'array',
            minItems: 1,
            items: operatorProposerContract.output_schema,
          },
          measurementRefs: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          decisionRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          outcome: { enum: [...operatorAttemptOutcomes] },
          phase: { const: 'metrics' },
          parentCandidateRef: { type: 'string', minLength: 1 },
          incumbentMeasurementRef: { type: 'string', minLength: 1 },
          round: { type: 'integer', minimum: 1 },
          candidateRefs: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          candidateDiagnosticMeasurementRef: {
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
        },
        required: [
          'action',
          'analysisRef',
          'historyRef',
          'actions',
          'measurementRefs',
          'decisionRef',
          'outcome',
          'phase',
          'parentCandidateRef',
          'incumbentMeasurementRef',
          'round',
          'candidateRefs',
          'candidateDiagnosticMeasurementRef',
        ],
        additionalProperties: false,
      },
    ],
  },
  output_schema: {
    type: 'object',
    properties: {
      action: { const: 'summarize' },
      summaryRef: { type: 'string', minLength: 1 },
      historyRef: { type: 'string', minLength: 1 },
    },
    required: ['action', 'summaryRef', 'historyRef'],
    additionalProperties: false,
  },
});
