import { defineContract } from '../contract.js';

export type MetricSelectorInput = {
  incumbentMeasurementRef: string;
  candidateMeasurementRef: string;
};
export type MetricSelectorOutput = {
  accepted: boolean;
  candidateFeasible: boolean;
  selectedCandidateRef: string;
  reason: string;
  decisionRef: string;
  measurementRef: string;
  metric: string;
  incumbentValue: number;
  candidateValue: number;
  selectedValue: number;
};

export const metricSelectorContract = defineContract({
  id: 'contract.selector-metrics',
  input_schema: {
    additionalProperties: false,
    properties: {
      candidateMeasurementRef: {
        minLength: 1,
        type: 'string',
      },
      incumbentMeasurementRef: {
        minLength: 1,
        type: 'string',
      },
    },
    required: ['incumbentMeasurementRef', 'candidateMeasurementRef'],
    type: 'object',
  },
  output_schema: {
    additionalProperties: false,
    properties: {
      accepted: {
        type: 'boolean',
      },
      candidateFeasible: {
        type: 'boolean',
      },
      candidateValue: {
        type: 'number',
      },
      decisionRef: {
        minLength: 1,
        type: 'string',
      },
      incumbentValue: {
        type: 'number',
      },
      measurementRef: {
        minLength: 1,
        type: 'string',
      },
      metric: {
        minLength: 1,
        type: 'string',
      },
      reason: {
        type: 'string',
      },
      selectedCandidateRef: {
        minLength: 1,
        type: 'string',
      },
      selectedValue: {
        type: 'number',
      },
    },
    required: [
      'accepted',
      'candidateFeasible',
      'selectedCandidateRef',
      'reason',
      'decisionRef',
      'measurementRef',
      'metric',
      'incumbentValue',
      'candidateValue',
      'selectedValue',
    ],
    type: 'object',
  },
});
