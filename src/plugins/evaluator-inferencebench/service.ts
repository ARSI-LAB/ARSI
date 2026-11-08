import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InferencebenchInput,
  InferencebenchOutput,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { inferencebenchContract } from '../../contracts/plugin-types/inferencebench.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import { evaluationStatus } from '../shared/evaluator-adapter/measurement.js';
import { nativeConfiguration } from './configuration.js';
import { normalizeEvaluation } from './measurement.js';
import { configSchema, type InferencebenchConfig } from './schema.js';
export async function createInferencebench(
  config: InferencebenchConfig,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<InferencebenchInput, InferencebenchOutput>> {
  validate(configSchema, config, 'evaluator config');
  return {
    async execute(input, context): Promise<InferencebenchOutput> {
      validate(inferencebenchContract.input_schema, input, 'evaluator input');
      return context.withInstance(
        input.candidateRef,
        'inference-endpoint',
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
          if (raw.exitCode !== 0) {
            const status = evaluationStatus(raw, context);
            if (
              input.reportFailedMeasurement &&
              Number.isInteger(raw.exitCode) &&
              status === 'failed'
            )
              return { measurementRef };
            throw Object.assign(
              new Error('Evaluator completed with nonzero exitCode'),
              {
                measurementRef,
                status,
                exitCode: raw.exitCode,
              },
            );
          }
          return { measurementRef };
        },
      );
    },
    async dispose(): Promise<void> {},
  };
}
