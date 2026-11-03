import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type ReflectionInput = {
  parentRevisionRefs: Record<string, string>;
  resourceRef: string;
  goal: string;
  evidenceRefs: string[];
  editConstraints: JsonObject;
};
export type ReflectionOutput =
  | {
      status: 'proposed';
      proposal: {
        parentRevisionRefs: Record<string, string>;
        resourceRef: string;
        changeRef: string;
      };
      reason: string;
    }
  | { status: 'no-change'; proposal: null; reason: string };

export const reflectionContract = defineContract({
  id: 'contract.reflection',
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
      parentRevisionRefs: {
        additionalProperties: {
          minLength: 1,
          type: 'string',
        },
        minProperties: 1,
        type: 'object',
      },
      resourceRef: {
        minLength: 1,
        type: 'string',
      },
    },
    required: [
      'parentRevisionRefs',
      'resourceRef',
      'goal',
      'evidenceRefs',
      'editConstraints',
    ],
    type: 'object',
  },
  output_schema: {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          proposal: {
            additionalProperties: false,
            properties: {
              changeRef: {
                minLength: 1,
                type: 'string',
              },
              parentRevisionRefs: {
                additionalProperties: {
                  minLength: 1,
                  type: 'string',
                },
                minProperties: 1,
                type: 'object',
              },
              resourceRef: {
                minLength: 1,
                type: 'string',
              },
            },
            required: ['parentRevisionRefs', 'resourceRef', 'changeRef'],
            type: 'object',
          },
          reason: {
            type: 'string',
          },
          status: {
            const: 'proposed',
          },
        },
        required: ['status', 'proposal', 'reason'],
        type: 'object',
      },
      {
        additionalProperties: false,
        properties: {
          proposal: {
            type: 'null',
          },
          reason: {
            type: 'string',
          },
          status: {
            const: 'no-change',
          },
        },
        required: ['status', 'proposal', 'reason'],
        type: 'object',
      },
    ],
  },
});
