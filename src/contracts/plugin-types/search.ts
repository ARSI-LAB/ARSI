import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';
import {
  proposerContract,
  type ProposerInput,
  type ProposerOutput,
} from './proposer.js';

export type SearchWork =
  | {
      kind: 'evaluation';
      id: string;
      /** An empty list acknowledges work that requires no external evaluation. */
      evaluations: { candidateRef: string; taskIds?: string[] }[];
      parameters?: JsonObject;
    }
  | ({
      kind: 'proposal';
      id: string;
      parentRefs: string[];
      taskIds: string[];
    } & (
      | { proposalInput: ProposerInput; proposalResult: null }
      | { proposalInput: null; proposalResult: ProposerOutput }
    ));

export type SearchFeedback =
  | {
      kind: 'evaluation';
      /** Measurements follow the order of the requested evaluations. */
      measurementRefs: string[];
      decisionRef?: string;
    }
  | {
      kind: 'proposal';
      parentMeasurementRefs: string[];
      proposal: ProposerOutput;
      proposalMeasurementRef: string | null;
    };

/**
 * Search implementations own their algorithm and immutable state artifacts.
 * Policies execute requested work and return feedback with its opaque work ID.
 * Continue with the returned stateRef, including after checkpoint recovery.
 * Suggest starts another attempt; observe can request further work for it.
 */
export type SearchInput =
  | {
      action: 'initialize';
      parent: string;
      feedbackTaskIds?: string[];
      selectionTaskIds?: string[];
    }
  | { action: 'suggest'; stateRef: string }
  | {
      action: 'observe';
      stateRef: string;
      workId: string;
      feedback: SearchFeedback;
    };

export type SearchOutput = {
  stateRef: string;
  done: boolean;
  /** Algorithm attempt limit, or null when the Policy supplies its own bound. */
  iterationLimit: number | null;
  work: SearchWork | null;
  /** Final implementation-specific deliverable; null while search is active. */
  result: JsonObject | null;
};

const ref = { type: 'string', minLength: 1 };
const refs = (minItems: number): JsonObject => ({
  type: 'array',
  minItems,
  uniqueItems: true,
  items: ref,
});
const shape = (
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const proposalWork = {
  kind: { const: 'proposal' },
  id: ref,
  parentRefs: refs(1),
  taskIds: refs(1),
};

export const searchContract = defineContract({
  id: 'contract.search',
  input_schema: {
    oneOf: [
      {
        ...shape(
          {
            action: { const: 'initialize' },
            parent: ref,
            feedbackTaskIds: refs(1),
            selectionTaskIds: refs(1),
          },
          ['action', 'parent'],
        ),
        dependencies: {
          feedbackTaskIds: ['selectionTaskIds'],
          selectionTaskIds: ['feedbackTaskIds'],
        },
      },
      shape({ action: { const: 'suggest' }, stateRef: ref }),
      shape({
        action: { const: 'observe' },
        stateRef: ref,
        workId: ref,
        feedback: {
          oneOf: [
            shape(
              {
                kind: { const: 'evaluation' },
                measurementRefs: { type: 'array', items: ref },
                decisionRef: ref,
              },
              ['kind', 'measurementRefs'],
            ),
            shape({
              kind: { const: 'proposal' },
              parentMeasurementRefs: { type: 'array', items: ref },
              proposal: proposerContract.output_schema,
              proposalMeasurementRef: { type: ['string', 'null'] },
            }),
          ],
        },
      }),
    ],
  },
  output_schema: shape({
    stateRef: ref,
    done: { type: 'boolean' },
    iterationLimit: { type: ['integer', 'null'], minimum: 0 },
    work: {
      oneOf: [
        { type: 'null' },
        shape(
          {
            kind: { const: 'evaluation' },
            id: ref,
            evaluations: {
              type: 'array',
              items: shape({ candidateRef: ref, taskIds: refs(1) }, [
                'candidateRef',
              ]),
            },
            parameters: { type: 'object' },
          },
          ['kind', 'id', 'evaluations'],
        ),
        shape({
          ...proposalWork,
          proposalInput: proposerContract.input_schema,
          proposalResult: { type: 'null' },
        }),
        shape({
          ...proposalWork,
          proposalInput: { type: 'null' },
          proposalResult: proposerContract.output_schema,
        }),
      ],
    },
    result: { anyOf: [{ type: 'null' }, { type: 'object' }] },
  }),
});
