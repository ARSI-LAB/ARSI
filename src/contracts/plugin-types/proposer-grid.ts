import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type GridProposerInput = { parent: string; cursor: number };
export type GridProposerOutput =
  | {
      status: 'candidate';
      candidateRef: string;
      parameters: JsonObject;
      nextCursor: number;
      totalCandidates: number;
    }
  | { status: 'exhausted'; nextCursor: number; totalCandidates: number };

const cursor = { type: 'integer', minimum: 0 };
export const gridProposerContract = defineContract({
  id: 'contract.proposer-grid',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { parent: { type: 'string', minLength: 1 }, cursor },
    required: ['parent', 'cursor'],
  },
  output_schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { const: 'candidate' },
          candidateRef: { type: 'string', minLength: 1 },
          parameters: {
            type: 'object',
            additionalProperties: true,
          },
          nextCursor: cursor,
          totalCandidates: { type: 'integer', minimum: 1 },
        },
        required: [
          'status',
          'candidateRef',
          'parameters',
          'nextCursor',
          'totalCandidates',
        ],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { const: 'exhausted' },
          nextCursor: cursor,
          totalCandidates: { type: 'integer', minimum: 1 },
        },
        required: ['status', 'nextCursor', 'totalCandidates'],
      },
    ],
  },
});
