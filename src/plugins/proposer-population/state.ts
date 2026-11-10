import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import {
  proposerContract,
  type ProposerInput,
  type ProposerOutput,
} from '../../contracts/plugin-types/proposer.js';
import { object } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { stringArray } from './schema.js';
import type {
  CandidateRecord,
  PopulationState,
  RoundReport,
} from './engine.js';

export interface RoundPlan extends JsonObject {
  report: RoundReport;
  proposalInput:
    | (Pick<ProposerInput, 'parent' | 'goal'> & { editConstraints: JsonObject })
    | null;
  proposalResult: ProposerOutput | null;
  candidate: CandidateRecord | null;
}

export type PopulationStepResult = {
  state: PopulationState;
  plan: RoundPlan | null;
  selectionRequired: boolean;
};

interface PopulationSnapshot extends JsonObject {
  schemaVersion: 'rsi.proposer-population-snapshot/v1';
  configuration: string;
  experimentId: string;
  bindingId: string;
  state: PopulationState;
  plan: RoundPlan | null;
}

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nonnegativeInteger = { type: 'integer', minimum: 0 };
const proposerProperties = object(
  object(proposerContract.input_schema).properties,
);
const proposalInputSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['parent', 'goal', 'editConstraints'],
  properties: {
    parent: proposerProperties.parent!,
    goal: proposerProperties.goal!,
    editConstraints: proposerProperties.editConstraints!,
  },
};

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

export const populationStateSchema: JsonObject = {
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
    schemaVersion: { const: 'rsi.proposer-population-state/v1' },
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
export const populationPlanSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'proposalInput', 'proposalResult', 'candidate'],
  properties: {
    report: roundReportSchema,
    proposalInput: {
      anyOf: [{ type: 'null' }, proposalInputSchema],
    },
    proposalResult: {
      anyOf: [{ type: 'null' }, proposerContract.output_schema],
    },
    candidate: { anyOf: [{ type: 'null' }, candidateSchema] },
  },
};

const snapshotSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'configuration',
    'experimentId',
    'bindingId',
    'state',
    'plan',
  ],
  properties: {
    schemaVersion: { const: 'rsi.proposer-population-snapshot/v1' },
    configuration: { type: 'string', minLength: 1 },
    experimentId: { type: 'string', minLength: 1 },
    bindingId: { type: 'string', minLength: 1 },
    state: populationStateSchema,
    plan: { anyOf: [{ type: 'null' }, populationPlanSchema] },
  },
};

export async function readPopulationState(
  context: RuntimeContext,
  stateRef: string,
  configuration: string,
): Promise<PopulationSnapshot> {
  const snapshot = parseConfig<PopulationSnapshot>(
    snapshotSchema,
    await context.artifacts.readJson(stateRef),
    'Population proposer state',
  );
  if (
    snapshot.configuration !== configuration ||
    snapshot.experimentId !== context.experimentId ||
    snapshot.bindingId !== context.bindingId
  )
    throw new Error(
      'Population proposer state configuration or execution scope mismatch',
    );
  return snapshot;
}

export async function writePopulationState(
  context: RuntimeContext,
  configuration: string,
  result: PopulationStepResult,
): Promise<string> {
  const snapshot: PopulationSnapshot = {
    schemaVersion: 'rsi.proposer-population-snapshot/v1',
    configuration,
    experimentId: context.experimentId,
    bindingId: context.bindingId,
    state: result.state,
    plan: result.plan,
  };
  validate(snapshotSchema, snapshot, 'Population proposer state');
  return context.artifacts.putJson(snapshot);
}
