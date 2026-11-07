import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { proposerContract } from '../../contracts/plugin-types/proposer.js';
import {
  populationProposalInputSchema,
  type PopulationSearchPlan,
} from '../../contracts/plugin-types/population-search.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { stringArray } from './schema.js';
import type { CandidateRecord, GepaState, RoundReport } from './engine.js';

export interface RoundPlan extends JsonObject {
  report: RoundReport;
  proposalInput: PopulationSearchPlan['proposalInput'];
  proposalResult: PopulationSearchPlan['proposalResult'];
  candidate: CandidateRecord | null;
}

export type GepaStepResult = {
  state: GepaState;
  plan: RoundPlan | null;
  selectionRequired: boolean;
};

interface GepaSnapshot extends JsonObject {
  schemaVersion: 'gepa.search/v1';
  configuration: string;
  experimentId: string;
  bindingId: string;
  state: GepaState;
  plan: RoundPlan | null;
}

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
      anyOf: [{ type: 'null' }, populationProposalInputSchema],
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
    schemaVersion: { const: 'gepa.search/v1' },
    configuration: { type: 'string', minLength: 1 },
    experimentId: { type: 'string', minLength: 1 },
    bindingId: { type: 'string', minLength: 1 },
    state: gepaStateSchema,
    plan: { anyOf: [{ type: 'null' }, gepaPlanSchema] },
  },
};

export async function readSearchState(
  context: RuntimeContext,
  stateRef: string,
  configuration: string,
): Promise<GepaSnapshot> {
  const snapshot = parseConfig<GepaSnapshot>(
    snapshotSchema,
    await context.artifacts.readJson(stateRef),
    'GEPA search state',
  );
  if (
    snapshot.configuration !== configuration ||
    snapshot.experimentId !== context.experimentId ||
    snapshot.bindingId !== context.bindingId
  )
    throw new Error(
      'GEPA search state configuration or execution scope mismatch',
    );
  return snapshot;
}

export async function writeSearchState(
  context: RuntimeContext,
  configuration: string,
  result: GepaStepResult,
): Promise<string> {
  const snapshot: GepaSnapshot = {
    schemaVersion: 'gepa.search/v1',
    configuration,
    experimentId: context.experimentId,
    bindingId: context.bindingId,
    state: result.state,
    plan: result.plan,
  };
  validate(snapshotSchema, snapshot, 'GEPA search state');
  return context.artifacts.putJson(snapshot);
}
