import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';
import { proposerContract, type ProposerOutput } from './proposer.js';

export type GepaModule = {
  /** Stable module identity used for rotation and merge bookkeeping. */
  id: string;
  /** Bundle-relative path edited by a mutation or merge. */
  path: string;
};

export type GepaSettings = {
  feedbackTaskIds: string[];
  selectionTaskIds: string[];
  maxRounds: number;
  maxRollouts: number;
  minibatchSize: number;
  paretoSize: number;
  seed: number;
  crossoverEvery: number;
  modules: GepaModule[];
  goal: string;
  editConstraints?: JsonObject;
};

type StatefulInput = { state: JsonObject; settings: GepaSettings };

export type GepaOptimizerInput =
  | { action: 'initialize'; candidateRef: string; settings: GepaSettings }
  | (StatefulInput & {
      action: 'observe-initial';
      measurementRef: string | null;
    })
  | (StatefulInput & { action: 'prepare' })
  | (StatefulInput & {
      action: 'compare';
      plan: JsonObject;
      parentMeasurementRefs: string[];
      proposal: ProposerOutput;
      proposalMeasurementRef: string | null;
    })
  | (StatefulInput & {
      action: 'select';
      plan: JsonObject;
      measurementRef: string;
    });

export type GepaOptimizerOutput = {
  state: JsonObject;
  plan: JsonObject | null;
  selectionRequired: boolean;
};

const stringArray = (minItems: number): JsonObject => ({
  type: 'array',
  minItems,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
});

const settingsSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'feedbackTaskIds',
    'selectionTaskIds',
    'maxRounds',
    'maxRollouts',
    'minibatchSize',
    'paretoSize',
    'seed',
    'crossoverEvery',
    'modules',
    'goal',
  ],
  properties: {
    feedbackTaskIds: stringArray(1),
    selectionTaskIds: stringArray(1),
    maxRounds: { type: 'integer', minimum: 0, maximum: 100000 },
    maxRollouts: { type: 'integer', minimum: 0, maximum: 1000000000 },
    minibatchSize: { type: 'integer', minimum: 1, maximum: 100000 },
    paretoSize: { type: 'integer', minimum: 1, maximum: 100000 },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    crossoverEvery: { type: 'integer', minimum: 0, maximum: 100000 },
    modules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path'],
        properties: {
          id: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
    goal: { type: 'string', minLength: 1 },
    editConstraints: { type: 'object' },
  },
};

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nonnegativeInteger = { type: 'integer', minimum: 0 };

const candidateSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ref',
    'artifactRef',
    'applicationParentRef',
    'parents',
    'ancestors',
    'origin',
    'createdRound',
    'scores',
    'aggregate',
    'aggregateComplete',
    'moduleIds',
  ],
  properties: {
    ref: { type: 'string', minLength: 1 },
    artifactRef: { type: 'string', minLength: 1 },
    applicationParentRef: nullableString,
    parents: stringArray(0),
    ancestors: stringArray(0),
    origin: { enum: ['base', 'mutation', 'crossover'] },
    createdRound: nonnegativeInteger,
    scores: { type: 'object', additionalProperties: nullableNumber },
    aggregate: nullableNumber,
    aggregateComplete: { type: 'boolean' },
    moduleIds: stringArray(1),
  },
};

const roundReportSchema: JsonObject = {
  type: 'object',
  required: [
    'round',
    'strategy',
    'status',
    'parentRefs',
    'ancestorRef',
    'moduleIds',
    'taskIds',
    'parentScores',
    'proposalScores',
    'candidateRef',
    'selectionScores',
    'rollouts',
    'reason',
  ],
  properties: {
    round: nonnegativeInteger,
    strategy: { enum: ['mutation', 'crossover'] },
    status: {
      enum: ['admitted', 'rejected', 'no-change', 'evaluation-failed'],
    },
    parentRefs: stringArray(1),
    ancestorRef: nullableString,
    moduleIds: stringArray(1),
    taskIds: stringArray(1),
    parentScores: { type: 'array', items: nullableNumber },
    proposalScores: { type: 'array', items: nullableNumber },
    candidateRef: nullableString,
    selectionScores: { type: 'object', additionalProperties: nullableNumber },
    rollouts: nonnegativeInteger,
    reason: { type: 'string' },
  },
};

export const gepaStateSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'seed',
    'rng',
    'feedbackTaskIds',
    'selectionTaskIds',
    'selectionTruncated',
    'baselineCandidateRef',
    'evaluationRefs',
    'selectionConditions',
    'candidates',
    'moduleCursor',
    'completedRounds',
    'rolloutsUsed',
    'mergeAttempts',
    'rounds',
    'bestCandidateRef',
    'bestAggregateScore',
    'done',
    'stopReason',
    'datasetDegenerate',
    'weightsChanged',
  ],
  properties: {
    schemaVersion: { const: 'gepa.state/v1' },
    seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
    rng: { type: 'integer', minimum: 0, maximum: 4294967295 },
    feedbackTaskIds: stringArray(1),
    selectionTaskIds: stringArray(0),
    selectionTruncated: { type: 'boolean' },
    baselineCandidateRef: nullableString,
    evaluationRefs: stringArray(0),
    selectionConditions: {
      type: 'object',
      additionalProperties: nullableString,
    },
    candidates: {
      type: 'array',
      items: candidateSchema,
    },
    moduleCursor: nonnegativeInteger,
    completedRounds: nonnegativeInteger,
    rolloutsUsed: nonnegativeInteger,
    mergeAttempts: stringArray(0),
    rounds: { type: 'array', items: roundReportSchema },
    bestCandidateRef: nullableString,
    bestAggregateScore: nullableNumber,
    done: { type: 'boolean' },
    stopReason: nullableString,
    datasetDegenerate: { type: 'boolean' },
    weightsChanged: { const: false },
  },
};
export const gepaPlanSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'proposalInput', 'proposalResult', 'candidate'],
  properties: {
    report: roundReportSchema,
    proposalInput: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['parent', 'goal', 'editConstraints'],
          properties: {
            parent: { type: 'string', minLength: 1 },
            goal: { type: 'string', minLength: 1 },
            editConstraints: { type: 'object' },
          },
        },
      ],
    },
    proposalResult: {
      anyOf: [{ type: 'null' }, proposerContract.output_schema],
    },
    candidate: { anyOf: [{ type: 'null' }, candidateSchema] },
  },
};

function stateAction(action: string, properties: JsonObject = {}): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'state', 'settings', ...Object.keys(properties)],
    properties: {
      action: { const: action },
      state: gepaStateSchema,
      settings: settingsSchema,
      ...properties,
    },
  };
}

export const gepaOptimizerContract = defineContract({
  id: 'contract.gepa-optimizer',
  input_schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'candidateRef', 'settings'],
        properties: {
          action: { const: 'initialize' },
          candidateRef: { type: 'string', minLength: 1 },
          settings: settingsSchema,
        },
      },
      stateAction('observe-initial', { measurementRef: nullableString }),
      stateAction('prepare'),
      stateAction('compare', {
        plan: gepaPlanSchema,
        parentMeasurementRefs: stringArray(0),
        proposal: proposerContract.output_schema,
        proposalMeasurementRef: nullableString,
      }),
      stateAction('select', {
        plan: gepaPlanSchema,
        measurementRef: { type: 'string', minLength: 1 },
      }),
    ],
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'plan', 'selectionRequired'],
    properties: {
      state: gepaStateSchema,
      plan: { anyOf: [{ type: 'null' }, gepaPlanSchema] },
      selectionRequired: { type: 'boolean' },
    },
  },
});
