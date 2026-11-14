import { canRestartBootstrap } from './bootstrap-recovery.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentbenchInput,
  AgentbenchOutput,
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  digest,
  object,
  string,
  strings,
  unknownKeys,
} from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { plain, redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import { evaluationStatus } from '../shared/evaluator-adapter/measurement.js';
import { normalizeEvaluation } from './measurement.js';
import { canRestartPreparation } from './preparation-recovery.js';
import { configSchema, type AgentbenchConfig } from './schema.js';
import {
  parseEvaluatorConfig,
  type SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';
import {
  isFinalizedVerifierTimeout,
  reconciledVerifierTimeout,
} from './finalized-timeout.js';
export async function createAgentbench(
  config: AgentbenchConfig,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<AgentbenchInput, AgentbenchOutput>> {
  validate(configSchema, config, 'evaluator config');
  const reconciled = new Map<
    string,
    { inputDigest: string; measurementRef: string | null; attempt: string }
  >();
  return {
    async canRetry(input, receipt, context) {
      const key = `${context.experimentId}/${context.callId}`;
      reconciled.delete(key);
      const measurementRef = await reconciledVerifierTimeout(
        input,
        receipt,
        context,
      );
      if (
        !measurementRef &&
        !(await canRestartPreparation(input, receipt, context)) &&
        !(await canRestartBootstrap(input, receipt, context))
      )
        return false;
      reconciled.set(key, {
        inputDigest: digest(input),
        measurementRef,
        attempt: digest(receipt),
      });
      return true;
    },
    async execute(input, context): Promise<AgentbenchOutput> {
      object(input);
      unknownKeys(input, ['candidateRef', 'taskIds'], 'evaluator input');
      string(input.candidateRef);
      const taskIds = strings('taskIds' in input ? input.taskIds : undefined);
      if (!taskIds.length || new Set(taskIds).size !== taskIds.length)
        throw new Error('taskIds must be nonempty and unique');
      context.signal.throwIfAborted();
      const key = `${context.experimentId}/${context.callId}`;
      const recovered = reconciled.get(key);
      if (recovered) {
        reconciled.delete(key);
        if (recovered.inputDigest !== digest(input))
          throw new Error('Reconciled evaluator input changed');
        if (recovered.measurementRef)
          return { measurementRef: recovered.measurementRef };
      }
      // A released acquisition receipt must never supply the new workspace.
      const withInstance = async <T>(
        candidateRef: string,
        capability: string,
        use: (execution: JsonObject) => Promise<T>,
      ): Promise<T> => {
        if (!recovered)
          return context.withInstance(candidateRef, capability, use);
        const instanceId =
          'instance-' +
          digest({
            callId: context.callId,
            attempt: recovered.attempt,
            candidateRef,
            capability,
          }).slice(0, 32);
        try {
          const acquired = await context.application({
            action: 'acquire',
            candidateRef,
            capability,
            instanceId,
          });
          return await use(object(acquired.execution));
        } finally {
          await context
            .extend({ signal: context.cleanup })
            .application({ action: 'release', instanceId });
        }
      };
      return withInstance(
        string(input.candidateRef),
        'agentbundle',
        async (execution) => {
          context.signal.throwIfAborted();
          await mkdir(context.directory, { recursive: true });
          const evaluationConfig = prepareEvaluationConfig(config, {
            taskIds,
            execution,
            directory: context.directory,
          });
          const configPath = join(context.directory, 'evaluator.json');
          await writeFile(configPath, JSON.stringify(evaluationConfig), {
            mode: 0o600,
          });
          await context.charge('evaluationRuns', 1);
          let result: unknown;
          try {
            result = await runner({
              configPath,
              signal: context.signal,
              env: process.env,
            });
          } catch (error) {
            const partial =
              error && typeof error === 'object' && 'result' in error
                ? error.result
                : null;
            const diagnostic = object(
              redact({
                name: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
                phase:
                  error && typeof error === 'object' && 'phase' in error
                    ? error.phase
                    : null,
              }),
            );
            const measurementRef = await normalizeEvaluation(
              evaluationConfig,
              input,
              execution,
              partial,
              context,
              diagnostic,
            );
            throw Object.assign(
              new Error(
                error instanceof Error ? error.message : String(error),
                { cause: error },
              ),
              {
                measurementRef,
                status: evaluationStatus(partial, context, true),
              },
            );
          }
          const measurementRef = await normalizeEvaluation(
            evaluationConfig,
            input,
            execution,
            result,
            context,
          );
          const raw = object(result);
          if (raw.snapshot === undefined)
            throw Object.assign(
              new Error('Evaluator result has no confirmed collected snapshot'),
              { measurementRef, status: 'unknown' },
            );
          context.signal.throwIfAborted();
          if (raw.exitCode !== 0 && !isFinalizedVerifierTimeout(raw, taskIds))
            throw Object.assign(
              new Error('Evaluator completed with nonzero exitCode'),
              {
                measurementRef,
                status: evaluationStatus(raw, context),
                exitCode: raw.exitCode,
              },
            );
          return { measurementRef };
        },
      );
    },
    async dispose(): Promise<void> {},
  };
}

export function prepareEvaluationConfig(
  rawConfig: unknown,
  {
    taskIds,
    execution,
    directory,
  }: {
    taskIds: string[];
    execution: JsonObject;
    directory: string;
  },
): SdkEvaluatorConfig {
  const config = object(rawConfig, 'evaluator config');
  const prepared = object(structuredClone(config));
  const benchmark: JsonObject =
    typeof prepared.benchmark === 'string'
      ? { name: prepared.benchmark }
      : object(prepared.benchmark, 'benchmark');
  const solver: JsonObject =
    typeof benchmark.solver === 'string'
      ? { name: benchmark.solver }
      : plain(benchmark.solver);
  benchmark.solver = {
    ...solver,
    name: 'agentbundle',
    config: {
      ...plain(solver.config),
      path: string(execution.directory, 'Bundle directory'),
    },
  };
  prepared.benchmark = benchmark;
  const run = plain(prepared.run);
  delete run.sampling;
  delete run.offset;
  prepared.run = { ...run, maxTasks: null, taskIds };
  prepared.output = {
    ...plain(prepared.output),
    directory: join(directory, 'sdk'),
  };
  const parsed = parseEvaluatorConfig(prepared);
  // The original solver and template still expose conflicts overwritten above.
  if (solver.name !== undefined && solver.name !== 'agentbundle')
    throw new Error('benchmark.solver must be agentbundle');
  if (plain(solver.config).path !== undefined)
    throw new Error('benchmark.solver.config.path is owned by RSI');
  if (plain(config.output).directory !== undefined)
    throw new Error('output.directory is owned by RSI');
  return parsed;
}
