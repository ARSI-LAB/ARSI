import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentbenchInput,
  AgentbenchOutput,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string, strings, unknownKeys } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import { evaluationStatus } from '../shared/evaluator-adapter/measurement.js';
import { nativeConfiguration } from './configuration.js';
import { normalizeEvaluation } from './measurement.js';
import { configSchema, type AgentbenchConfig } from './schema.js';
export async function createAgentbench(
  config: AgentbenchConfig,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<AgentbenchInput, AgentbenchOutput>> {
  validate(configSchema, config, 'evaluator config');
  return {
    async execute(input, context): Promise<AgentbenchOutput> {
      object(input);
      unknownKeys(input, ['candidateRef', 'taskIds'], 'evaluator input');
      string(input.candidateRef);
      const ids = strings('taskIds' in input ? input.taskIds : undefined);
      if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error('taskIds must be nonempty and unique');
      return context.withInstance(
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
          if (raw.exitCode !== 0)
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
