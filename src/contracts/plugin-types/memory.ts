import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type MemoryInput = {
  /** Immutable file-tree artifact for the active Memory, or null on the first invocation. */
  resourceRef: string | null;
  parentVersionRef: string | null;
  goal: string;
  /** References to Runtime-prepared runtime evolution evidence snapshots. */
  evidenceRefs: string[];
  editConstraints: JsonObject;
};

export type MemoryOutput =
  | {
      status: 'updated';
      resourceRef: string;
      changeRef: string;
      reason: string;
    }
  | {
      status: 'no-change';
      resourceRef: string | null;
      changeRef: null;
      reason: string;
    };

const reference = { type: 'string', minLength: 1 };

export const memoryContract = defineContract({
  id: 'contract.memory',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'parentVersionRef',
      'resourceRef',
      'goal',
      'evidenceRefs',
      'editConstraints',
    ],
    properties: {
      parentVersionRef: { anyOf: [reference, { type: 'null' }] },
      resourceRef: { anyOf: [reference, { type: 'null' }] },
      goal: { type: 'string', minLength: 1 },
      evidenceRefs: { type: 'array', items: reference },
      editConstraints: { type: 'object' },
    },
  },
  output_schema: {
    oneOf: ['updated', 'no-change'].map((status) => {
      const ref = status === 'updated' ? reference : { type: 'null' };
      return {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'resourceRef', 'changeRef', 'reason'],
        properties: {
          status: { const: status },
          resourceRef:
            status === 'updated'
              ? reference
              : { anyOf: [reference, { type: 'null' }] },
          changeRef: ref,
          reason: { type: 'string' },
        },
      };
    }),
  },
});
