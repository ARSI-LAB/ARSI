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

export type SingleProposerOutput =
  | ({ status: 'created' } & ProposedCandidate)
  | {
      status: 'no-change';
      candidateRef: string;
      diffRef: null;
      rationale: string;
    };

export type ProposerOutput =
  | SingleProposerOutput
  | { status: 'batch'; candidates: ProposedCandidate[] };

const candidateProperties = {
  candidateRef: { type: 'string', minLength: 1 },
  rationale: { type: 'string' },
};
const diffRefSchema = { type: 'string', minLength: 1 };

function proposalOutputSchema(
  status: 'created' | 'no-change',
  diffRef: JsonObject,
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'candidateRef', 'diffRef', 'rationale'],
    properties: { ...candidateProperties, status: { const: status }, diffRef },
  };
}

const createdProposalSchema = proposalOutputSchema('created', diffRefSchema);
const noChangeProposalSchema = proposalOutputSchema('no-change', {
  type: 'null',
});
export const singleProposerOutputSchema = {
  oneOf: [createdProposalSchema, noChangeProposalSchema],
};

export const singleProposerInputSchema: JsonObject & {
  properties: JsonObject;
} = {
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
};

export const proposerContract = defineContract({
  id: 'contract.proposer',
  input_schema: {
    ...singleProposerInputSchema,
    properties: {
      ...singleProposerInputSchema.properties,
      maxCandidates: {
        type: 'integer',
        minimum: 1,
        maximum: maxProposalBatchSize,
      },
      observations: { type: 'object' },
    },
  },
  output_schema: {
    oneOf: [
      createdProposalSchema,
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
              properties: { ...candidateProperties, diffRef: diffRefSchema },
            },
          },
        },
      },
      noChangeProposalSchema,
    ],
  },
});
