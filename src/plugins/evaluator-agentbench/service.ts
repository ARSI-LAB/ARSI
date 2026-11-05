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
import { redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import { evaluationStatus } from '../shared/evaluator-adapter/measurement.js';
import { nativeConfiguration } from './configuration.js';
import { normalizeEvaluation } from './measurement.js';
import { canRestartPreparation } from './preparation-recovery.js';
import { configSchema, type AgentbenchConfig } from './schema.js';
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
        !(await canRestartPreparation(input, receipt, context))
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
      const ids = strings('taskIds' in input ? input.taskIds : undefined);
      if (!ids.length || new Set(ids).size !== ids.length)
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
          const native = nativeConfiguration(
            config,
            input,
            execution,
            context.directory,
          );
          const configPath = join(context.directory, 'evaluator.json');
          await writeFile(configPath, JSON.stringify(native), {
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
              native,
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
            native,
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
          if (raw.exitCode !== 0 && !isFinalizedVerifierTimeout(raw, ids))
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
