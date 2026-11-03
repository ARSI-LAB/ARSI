import { readFile } from 'node:fs/promises';
import type {
  JsonObject,
  Operation,
  ParameterSearchInput,
  ParameterSearchOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { canonical, digest, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { parameterSearchProposerContract } from '../../contracts/plugin-types/proposer-parameter-search.js';
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
): ParameterSearchOutput {
  const trial = history[history.length - 1]!;
  if (!trial.candidateRef)
    throw new Error('Pending trial is missing candidate');
  return {
    action: 'suggest',
    status: 'candidate',
    stateRef,
    trialId: String(history.length - 1),
    candidateRef: trial.candidateRef,
    parameters: trial.parameters,
  };
}

export async function createOptunaProposer(
  raw: OptunaConfig,
  _services: RuntimeContext,
  worker: OptunaWorker = runOptunaWorker,
): Promise<Operation<ParameterSearchInput, ParameterSearchOutput>> {
  const config = parseOptunaConfig(raw);
  const workerDigest = digest(await readFile(workerPath, 'utf8'));
  const settings = object(config);
  const configuration = digest({ settings, workerDigest });
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
    async execute(input, context): Promise<ParameterSearchOutput> {
      validate(
        parameterSearchProposerContract.input_schema,
        input,
        'Parameter search input',
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
        return {
          action: 'initialize',
          stateRef: await context.artifacts.putJson(state),
        };
      }
      const state = parseSearchState(
        await context.artifacts.readJson(input.stateRef),
      );
      if (
        state.experimentId !== context.experimentId ||
        state.bindingId !== context.bindingId ||
        state.configuration !== configuration
      )
        throw new Error(
          'Parameter search identity/scope/configuration mismatch',
        );
      const history = state.history;
      if (input.action === 'observe') {
        const index = Number(input.trialId);
        if (
          !Number.isInteger(index) ||
          String(index) !== input.trialId ||
          index < 0 ||
          index >= history.length
        )
          throw new Error('Unknown parameter search trial');
        const trial = history[index]!;
        if (trial.status === 'complete') {
          if (
            trial.measurementRef !== input.measurementRef ||
            trial.decisionRef !== input.decisionRef
          )
            throw new Error('Conflicting trial feedback');
          return { action: 'observe', stateRef: input.stateRef };
        }
        if (
          trial.status !== 'pending' ||
          index !== history.length - 1 ||
          !trial.candidateRef
        )
          throw new Error('Feedback requires the pending trial');
        const feedback = await readDecisionFeedback(
          input.measurementRef,
          input.decisionRef,
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
          measurementRef: input.measurementRef,
          decisionRef: input.decisionRef,
          loss: feedback.loss,
          constraints: feedback.constraints,
        });
        return {
          action: 'observe',
          stateRef: await context.artifacts.putJson(state),
        };
      }
      if (history.at(-1)?.status === 'pending')
        return pendingOutput(input.stateRef, history);
      const seen = new Set(history.map((t) => canonical(t.parameters)));
      const stopped = async (
        reason: 'search-exhausted' | 'sampling-limit',
      ): Promise<ParameterSearchOutput> => ({
        action: 'suggest',
        status: 'stopped',
        stateRef: await context.artifacts.putJson(state),
        reason,
      });
      if (total !== null && seen.size >= total)
        return stopped('search-exhausted');
      for (
        let attempt = 0;
        attempt < 32 && history.length < config.maxSamplingAttempts;
        attempt++
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
