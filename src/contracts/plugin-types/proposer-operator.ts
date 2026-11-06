import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export const operatorAttemptOutcomes = [
  'adopted',
  'verified-no-gain',
  'verification-failed',
  'no-change',
  'proposal-failed',
] as const;
export type OperatorAttemptOutcome = (typeof operatorAttemptOutcomes)[number];

/** Policy passes immutable analysis/history references between independent actions. */
export type StaticOperatorProposerInput =
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
      action: 'summarize';
      phase: 'static';
      entryCandidateRef: string;
      analysisRef: string;
      historyRef: string | null;
      attempt: number;
      candidateRefs: string[];
      measurementRefs: string[];
      decisionRef: string | null;
      outcome: OperatorAttemptOutcome;
    };

export type MetricsOperatorProposerInput =
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
    }
  | {
      action: 'summarize';
      phase: 'metrics';
      parentCandidateRef: string;
      incumbentMeasurementRef: string;
      analysisRef: string;
      round: number;
      historyRef: string | null;
      staticHistoryRef: string | null;
      candidateRefs: string[];
      measurementRefs: string[];
      decisionRef: string | null;
      candidateDiagnosticMeasurementRef: string | null;
      outcome: OperatorAttemptOutcome;
    };
export type OperatorProposerInput =
  | StaticOperatorProposerInput
  | MetricsOperatorProposerInput;
export type OperatorProposalFailure = {
  action: 'propose' | 'repair';
  status: 'failed';
  candidateRef: string;
  diffRef: null;
  analysisRef: string;
  errorRef: string;
  rationale: string;
  reasonCode: 'invalid-model-output';
};

type CandidateOutput<Action extends 'propose' | 'repair'> = {
  action: Action;
  candidateRef: string;
  rationale: string;
  analysisRef: string;
} & (
  | { status: 'created'; diffRef: string; reasonCode: 'created' }
  | {
      status: 'no-change';
      diffRef: null;
      reasonCode:
        | 'no-supported-change'
        | (Action extends 'propose' ? 'no-static-issues' : never);
    }
);
export type OperatorProposerOutput =
  | CandidateOutput<'propose'>
  | CandidateOutput<'repair'>
  | OperatorProposalFailure
  | { action: 'summarize'; historyRef: string; summaryRef: string };

const ref: JsonObject = { type: 'string', minLength: 1 };
const nullableRef: JsonObject = { anyOf: [ref, { type: 'null' }] };
const attempt: JsonObject = { type: 'integer', minimum: 1, maximum: 3 };
const shape = (properties: JsonObject): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const refs = (minimum: number): JsonObject => ({
  type: 'array',
  minItems: minimum,
  maxItems: 4,
  uniqueItems: true,
  items: ref,
});
const candidateOutput = (
  action: 'propose' | 'repair',
  created: boolean,
): JsonObject =>
  shape({
    action: { const: action },
    status: { const: created ? 'created' : 'no-change' },
    candidateRef: ref,
    diffRef: created ? ref : { type: 'null' },
    rationale: { type: 'string' },
    analysisRef: ref,
    reasonCode: created
      ? { const: 'created' }
      : {
          enum:
            action === 'propose'
              ? ['no-static-issues', 'no-supported-change']
              : ['no-supported-change'],
        },
  });

export const operatorProposerContract = defineContract({
  id: 'contract.proposer-operator',
  input_schema: {
    oneOf: [
      shape({
        action: { const: 'propose' },
        phase: { const: 'static' },
        entryCandidateRef: ref,
        baselineMeasurementRef: ref,
        attempt,
        goal: ref,
        analysisRef: nullableRef,
        historyRef: nullableRef,
      }),
      shape({
        action: { const: 'repair' },
        phase: { const: 'static' },
        failedCandidateRef: ref,
        measurementRef: ref,
        analysisRef: ref,
        historyRef: nullableRef,
        attempt,
        repairIndex: attempt,
        goal: ref,
      }),
      shape({
        action: { const: 'summarize' },
        phase: { const: 'static' },
        entryCandidateRef: ref,
        analysisRef: ref,
        historyRef: nullableRef,
        attempt,
        candidateRefs: refs(1),
        measurementRefs: refs(0),
        decisionRef: nullableRef,
        outcome: { enum: [...operatorAttemptOutcomes] },
      }),
      shape({
        action: { const: 'propose' },
        phase: { const: 'metrics' },
        parentCandidateRef: ref,
        incumbentMeasurementRef: ref,
        diagnosticMeasurementRef: ref,
        round: { type: 'integer', minimum: 1, maximum: 10 },
        historyRef: nullableRef,
        staticHistoryRef: nullableRef,
        goal: ref,
      }),
      shape({
        action: { const: 'repair' },
        phase: { const: 'metrics' },
        failedCandidateRef: ref,
        measurementRef: ref,
        analysisRef: ref,
        round: { type: 'integer', minimum: 1, maximum: 10 },
        repairIndex: attempt,
        historyRef: nullableRef,
        staticHistoryRef: nullableRef,
        goal: ref,
      }),
      shape({
        action: { const: 'summarize' },
        phase: { const: 'metrics' },
        parentCandidateRef: ref,
        incumbentMeasurementRef: ref,
        analysisRef: ref,
        round: { type: 'integer', minimum: 1, maximum: 10 },
        historyRef: nullableRef,
        staticHistoryRef: nullableRef,
        candidateRefs: refs(0),
        measurementRefs: refs(0),
        decisionRef: nullableRef,
        candidateDiagnosticMeasurementRef: nullableRef,
        outcome: { enum: [...operatorAttemptOutcomes] },
      }),
    ],
  },
  output_schema: {
    oneOf: [
      candidateOutput('propose', true),
      candidateOutput('propose', false),
      candidateOutput('repair', true),
      candidateOutput('repair', false),
      ...(['propose', 'repair'] as const).map((action) =>
        shape({
          action: { const: action },
          status: { const: 'failed' },
          candidateRef: ref,
          diffRef: { type: 'null' },
          analysisRef: ref,
          errorRef: ref,
          rationale: { type: 'string' },
          reasonCode: { const: 'invalid-model-output' },
        }),
      ),
      shape({
        action: { const: 'summarize' },
        historyRef: ref,
        summaryRef: ref,
      }),
    ],
  },
});
