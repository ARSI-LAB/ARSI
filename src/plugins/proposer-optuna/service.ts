import { readFile } from 'node:fs/promises';
import type {
  JsonObject,
  Operation,
  IterativeProposerInput,
  IterativeProposerOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { canonical, digest, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { iterativeProposerContract } from '../../contracts/plugin-types/proposer-iterative.js';
import { commitParameters } from '../shared/parameter-editing/index.js';
import { readDecisionFeedback } from '../shared/metric-decision/index.js';
import {
  parseOptunaConfig,
  validateParameters,
  type OptunaConfig,
  type ResolvedOptunaConfig,
} from './schema.js';
import {
  parseSearchState,
  type SearchState,
  type SearchTrial,
} from './state.js';
import { runOptunaWorker, workerPath, type OptunaWorker } from './worker.js';

function cardinality(config: ResolvedOptunaConfig): number | null {
  let count = 1;
  for (const axis of config.searchSpace) {
    if (axis.distribution === 'categorical') count *= axis.values.length;
    else if (axis.step !== undefined || axis.distribution === 'int')
      count *= Math.round((axis.high - axis.low) / (axis.step ?? 1)) + 1;
    else if (axis.low === axis.high) count *= 1;
    else return null;
    if (!Number.isSafeInteger(count)) return null;
  }
  return count;
}
function pendingOutput(
  stateRef: string,
  history: SearchTrial[],
): IterativeProposerOutput {
  const trial = history[history.length - 1]!;
  if (!trial.candidateRef)
    throw new Error('Pending trial is missing candidate');
  return {
    stateRef,
    done: false,
    iterationLimit: null,
    work: {
      kind: 'evaluation',
      id: String(history.length - 1),
      evaluations: [{ candidateRef: trial.candidateRef }],
      parameters: trial.parameters,
    },
    result: null,
  };
}

function idleOutput(stateRef: string): IterativeProposerOutput {
  return {
    stateRef,
    done: false,
    iterationLimit: null,
    work: null,
    result: null,
  };
}

export async function createOptunaProposer(
  raw: OptunaConfig,
  _services: RuntimeContext,
  worker: OptunaWorker = runOptunaWorker,
): Promise<Operation<IterativeProposerInput, IterativeProposerOutput>> {
  const config = parseOptunaConfig(raw);
  const workerDigest = digest(await readFile(workerPath, 'utf8'));
  const settings = object(config);
  const configuration = digest({ settings, workerDigest });
  // Older checkpoints included defaults even when neither limit was set.
  const previousConfiguration = digest({
    settings: {
      ...settings,
      maxSamplingAttempts: config.maxSamplingAttempts ?? 1000,
      python: { timeoutMs: 30000, ...config.python },
    },
    workerDigest,
  });
  const total = cardinality(config);
  const request = async (
    action: 'check' | 'suggest',
    history: SearchTrial[],
    context: RuntimeContext,
  ): Promise<JsonObject> => {
    context.signal.throwIfAborted();
    const response = await worker(
      config,
      {
        action,
        sampler: object(config.sampler),
        constraintHandling: config.constraintHandling,
        searchSpace: config.searchSpace,
        history,
      },
      context.signal,
    );
    validate(
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          environment: {
            type: 'object',
            additionalProperties: false,
            properties: {
              python: { type: 'string' },
              optuna: { const: '4.5.0' },
              numpy: { const: '2.2.6' },
            },
            required: ['python', 'optuna', 'numpy'],
          },
          parameters: { type: 'object' },
        },
        required:
          action === 'check' ? ['environment'] : ['environment', 'parameters'],
      },
      response,
      'Optuna worker response',
    );
    context.signal.throwIfAborted();
    return response;
  };
  return {
    async execute(input, context): Promise<IterativeProposerOutput> {
      validate(
        iterativeProposerContract.input_schema,
        input,
        'Iterative parameter proposal input',
      );
      context.signal.throwIfAborted();
      if (input.action === 'initialize') {
        await context.readCandidate(input.parent);
        const checked = await request('check', [], context);
        const state: SearchState = {
          schemaVersion: 'rsi.parameter-search/v1',
          experimentId: context.experimentId,
          bindingId: context.bindingId,
          parent: input.parent,
          configuration,
          settings,
          workerDigest,
          environment: object(checked.environment),
          objectiveIdentity: null,
          comparisonKey: null,
          history: [],
        };
        return idleOutput(await context.artifacts.putJson(state));
      }
      const state = parseSearchState(
        await context.artifacts.readJson(input.stateRef),
      );
      if (
        state.experimentId !== context.experimentId ||
        state.bindingId !== context.bindingId ||
        (state.configuration !== configuration &&
          state.configuration !== previousConfiguration)
      )
        throw new Error(
          'Parameter search identity/scope/configuration mismatch',
        );
      state.configuration = configuration;
      state.settings = settings;
      const history = state.history;
      if (input.action === 'observe') {
        if (
          input.feedback.kind !== 'evaluation' ||
          input.feedback.measurementRefs.length !== 1 ||
          !input.feedback.decisionRef
        )
          throw new Error(
            'Optuna feedback requires one measurement and a decision',
          );
        const measurementRef = input.feedback.measurementRefs[0]!;
        const decisionRef = input.feedback.decisionRef;
        const index = Number(input.workId);
        if (
          !Number.isInteger(index) ||
          String(index) !== input.workId ||
          index < 0 ||
          index >= history.length
        )
          throw new Error('Unknown parameter search trial');
        const trial = history[index]!;
        if (trial.status === 'complete') {
          if (
            trial.measurementRef !== measurementRef ||
            trial.decisionRef !== decisionRef
          )
            throw new Error('Conflicting trial feedback');
          return idleOutput(input.stateRef);
        }
        if (
          trial.status !== 'pending' ||
          index !== history.length - 1 ||
          !trial.candidateRef
        )
          throw new Error('Feedback requires the pending trial');
        const feedback = await readDecisionFeedback(
          measurementRef,
          decisionRef,
          trial.candidateRef,
          context,
        );
        if (
          state.objectiveIdentity !== null &&
          (canonical(state.objectiveIdentity) !==
            canonical(feedback.identity) ||
            state.comparisonKey !== feedback.comparisonKey)
        )
          throw new Error('Search objective or comparison identity changed');
        state.objectiveIdentity = feedback.identity;
        state.comparisonKey = feedback.comparisonKey;
        Object.assign(trial, {
          status: 'complete',
          measurementRef,
          decisionRef,
          loss: feedback.loss,
          constraints: feedback.constraints,
        });
        return idleOutput(await context.artifacts.putJson(state));
      }
      if (history.at(-1)?.status === 'pending')
        return pendingOutput(input.stateRef, history);
      const seen = new Set(history.map((t) => canonical(t.parameters)));
      const stopped = async (
        reason: 'search-exhausted' | 'sampling-limit',
      ): Promise<IterativeProposerOutput> => ({
        stateRef: await context.artifacts.putJson(state),
        done: true,
        iterationLimit: null,
        work: null,
        result: { reason },
      });
      if (total !== null && seen.size >= total)
        return stopped('search-exhausted');
      while (
        config.maxSamplingAttempts === undefined ||
        history.length < config.maxSamplingAttempts
      ) {
        const response = await request('suggest', history, context);
        if (canonical(response.environment) !== canonical(state.environment))
          throw new Error('Optuna environment identity changed');
        const parameters = object(response.parameters);
        validateParameters(parameters, config.searchSpace);
        const duplicate = seen.has(canonical(parameters));
        const trial: SearchTrial = {
          parameters,
          status: duplicate ? 'duplicate' : 'pending',
          candidateRef: null,
          measurementRef: null,
          decisionRef: null,
          loss: null,
          constraints: [],
        };
        if (!duplicate)
          trial.candidateRef = await commitParameters(
            state.parent,
            config.path,
            parameters,
            context,
          );
        history.push(trial);
        if (!duplicate)
          return pendingOutput(await context.artifacts.putJson(state), history);
      }
      return stopped('sampling-limit');
    },
    async dispose(): Promise<void> {},
  };
}
