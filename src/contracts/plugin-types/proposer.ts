import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

const maxProposalBatchSize = 6;

export type ProposerInput = {
  parent: string;
  goal: string;
  evidenceRefs: string[];
  sources?: { candidateRef: string; measurementRef?: string }[];
  memoryRef?: string | null;
  observations?: JsonObject;
  editConstraints?: JsonObject;
  maxCandidates?: number;
};

type ProposedCandidate = {
  candidateRef: string;
  diffRef: string;
  rationale: string;
};

export type ProposerOutput =
  | ({ status: 'created' } & ProposedCandidate)
  | { status: 'batch'; candidates: ProposedCandidate[] }
  | {
      status: 'no-change';
      candidateRef: string;
      diffRef: null;
      rationale: string;
    };

const candidateProperties = {
  candidateRef: { type: 'string', minLength: 1 },
  diffRef: { type: 'string', minLength: 1 },
  rationale: { type: 'string' },
} as const;

export const proposerContract = defineContract({
  id: 'contract.proposer',
  input_schema: {
    additionalProperties: false,
    properties: {
      editConstraints: {
        type: 'object',
      },
      evidenceRefs: {
        items: {
          minLength: 1,
          type: 'string',
        },
        type: 'array',
      },
      goal: {
        minLength: 1,
        type: 'string',
      },
      maxCandidates: {
        type: 'integer',
        minimum: 1,
        maximum: maxProposalBatchSize,
      },
      memoryRef: {
        anyOf: [
          {
            minLength: 1,
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
      },
      observations: { type: 'object' },
      parent: {
        minLength: 1,
        type: 'string',
      },
      sources: {
        items: {
          additionalProperties: false,
          properties: {
            candidateRef: {
              minLength: 1,
              type: 'string',
            },
            measurementRef: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['candidateRef'],
          type: 'object',
        },
        type: 'array',
      },
    },
    required: ['parent', 'goal', 'evidenceRefs'],
    type: 'object',
  },
  output_schema: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          ...candidateProperties,
          status: {
            const: 'created',
          },
        },
        required: ['status', 'candidateRef', 'diffRef', 'rationale'],
        type: 'object',
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'candidates'],
        properties: {
          status: { const: 'batch' },
          candidates: {
            type: 'array',
            minItems: 1,
            maxItems: maxProposalBatchSize,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['candidateRef', 'diffRef', 'rationale'],
              properties: candidateProperties,
            },
          },
        },
      },
      {
        additionalProperties: false,
        properties: {
          candidateRef: {
            minLength: 1,
            type: 'string',
          },
          diffRef: {
            type: 'null',
          },
          rationale: {
            type: 'string',
          },
          status: {
            const: 'no-change',
          },
        },
        required: ['status', 'candidateRef', 'diffRef', 'rationale'],
        type: 'object',
      },
    ],
  },
});
