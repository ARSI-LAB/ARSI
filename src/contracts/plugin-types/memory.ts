import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';
import { object } from '../../shared/json.js';

export type MemoryInput = {
  memoryRef: string | null;
  goal: string;
  evidenceRefs: string[];
  editConstraints?: JsonObject;
  comparison?: {
    baselineCandidateRef: string;
    probes: Record<
      string,
      { candidateRef: string; measurementRef: string; slot?: number }[]
    >;
    selection: {
      candidateRef: string;
      measurementRef: string;
      decisionRef: string;
    };
  };
  observations?: JsonObject | null;
  sources?: { candidateRef: string }[];
};
export type MemoryOutput =
  | { status: 'updated'; memoryRef: string; changeRef: string; reason: string }
  | {
      status: 'no-change';
      memoryRef: string | null;
      changeRef: null;
      reason: string;
    };

export const memoryContract = defineContract({
  id: 'contract.memory',
  input_schema: {
    additionalProperties: false,
    properties: {
      comparison: {
        additionalProperties: false,
        properties: {
          baselineCandidateRef: {
            minLength: 1,
            type: 'string',
          },
          probes: {
            additionalProperties: {
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
                  slot: {
                    minimum: 0,
                    type: 'integer',
                  },
                },
                required: ['candidateRef', 'measurementRef'],
                type: 'object',
              },
              maxItems: 100,
              minItems: 1,
              type: 'array',
            },
            maxProperties: 16,
            minProperties: 1,
            type: 'object',
          },
          selection: {
            additionalProperties: false,
            properties: {
              candidateRef: {
                minLength: 1,
                type: 'string',
              },
              decisionRef: {
                minLength: 1,
                type: 'string',
              },
              measurementRef: {
                minLength: 1,
                type: 'string',
              },
            },
            required: ['candidateRef', 'measurementRef', 'decisionRef'],
            type: 'object',
          },
        },
        required: ['baselineCandidateRef', 'probes', 'selection'],
        type: 'object',
      },
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
      observations: {
        type: ['object', 'null'],
      },
      sources: {
        items: {
          additionalProperties: false,
          properties: {
            candidateRef: {
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
    required: ['memoryRef', 'goal', 'evidenceRefs'],
    type: 'object',
  },
  output_schema: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          changeRef: {
            minLength: 1,
            type: 'string',
          },
          memoryRef: {
            minLength: 1,
            type: 'string',
          },
          reason: {
            type: 'string',
          },
          status: {
            const: 'updated',
          },
        },
        required: ['status', 'memoryRef', 'changeRef', 'reason'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          changeRef: {
            type: 'null',
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
          reason: {
            type: 'string',
          },
          status: {
            const: 'no-change',
          },
        },
        required: ['status', 'memoryRef', 'changeRef', 'reason'],
        type: 'object',
      },
    ],
  },
});

export const memoryComparisonSchema = object(
  object(object(memoryContract.input_schema).properties).comparison,
);
