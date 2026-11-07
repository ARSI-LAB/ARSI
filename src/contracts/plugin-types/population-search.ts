import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';
import { proposerContract, type ProposerOutput } from './proposer.js';
import datasetSchema from '../models/train-validation-dataset.json' with { type: 'json' };

export type PopulationSearchDataset = {
  trainTaskIds: string[];
  validationTaskIds: string[];
};

/** Work the Policy performs while the search implementation owns its population. */
export type PopulationSearchPlan = {
  parentRefs: string[];
  taskIds: string[];
  proposalInput: {
    parent: string;
    goal: string;
    editConstraints: JsonObject;
  } | null;
  proposalResult: ProposerOutput | null;
};

/**
 * Every action returns a new immutable state reference. Continue with that
 * reference, including after checkpoint recovery; never edit its contents.
 * Initialize and compare may request evaluation, followed by observe-initial
 * and select respectively. Prepare requests proposal/comparison work.
 * Implementations reject state references from another configuration or scope.
 */
export type PopulationSearchInput =
  | {
      action: 'initialize';
      candidateRef: string;
      dataset: PopulationSearchDataset;
    }
  | {
      action: 'observe-initial';
      stateRef: string;
      measurementRef: string | null;
    }
  | { action: 'prepare'; stateRef: string }
  | {
      action: 'compare';
      stateRef: string;
      parentMeasurementRefs: string[];
      proposal: ProposerOutput;
      proposalMeasurementRef: string | null;
    }
  | { action: 'select'; stateRef: string; measurementRef: string };

export type PopulationSearchOutput = {
  stateRef: string;
  done: boolean;
  iterationLimit: number;
  evaluation: { candidateRef: string; taskIds: string[] } | null;
  plan: PopulationSearchPlan | null;
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
const shape = (properties: JsonObject): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const nullableRef = { type: ['string', 'null'] };
export const populationProposalInputSchema: JsonObject = shape({
  parent: ref,
  goal: ref,
  editConstraints: { type: 'object' },
});
const plan = shape({
  parentRefs: refs(1),
  taskIds: refs(1),
  proposalInput: {
    anyOf: [{ type: 'null' }, populationProposalInputSchema],
  },
  proposalResult: {
    anyOf: [{ type: 'null' }, proposerContract.output_schema],
  },
});

export const populationSearchContract = defineContract({
  id: 'contract.population-search',
  input_schema: {
    oneOf: [
      shape({
        action: { const: 'initialize' },
        candidateRef: ref,
        dataset: datasetSchema,
      }),
      shape({
        action: { const: 'observe-initial' },
        stateRef: ref,
        measurementRef: nullableRef,
      }),
      shape({ action: { const: 'prepare' }, stateRef: ref }),
      shape({
        action: { const: 'compare' },
        stateRef: ref,
        parentMeasurementRefs: refs(0),
        proposal: proposerContract.output_schema,
        proposalMeasurementRef: nullableRef,
      }),
      shape({
        action: { const: 'select' },
        stateRef: ref,
        measurementRef: ref,
      }),
    ],
  },
  output_schema: shape({
    stateRef: ref,
    done: { type: 'boolean' },
    iterationLimit: { type: 'integer', minimum: 0 },
    evaluation: {
      anyOf: [{ type: 'null' }, shape({ candidateRef: ref, taskIds: refs(1) })],
    },
    plan: { anyOf: [{ type: 'null' }, plan] },
    result: { anyOf: [{ type: 'null' }, { type: 'object' }] },
  }),
});
