import { OperationRejectedError } from '../../contracts/runtime/errors.js';
import { errorText } from '../../shared/errors.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InferencebenchInput,
  InferencebenchOutput,
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { plain, redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import {
  parseEvaluatorConfig,
  type SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';
import { normalizeEvaluation } from './measurement.js';
import type { EvaluatorConfig } from './schema.js';
import { inferencebenchDoctor } from './doctor.js';
export async function createInferencebench(
  config: EvaluatorConfig,
  ctx: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<InferencebenchInput, InferencebenchOutput>> {
  ctx.event?.on('rsi/doctor', inferencebenchDoctor);
  return {
    async execute(input, context): Promise<InferencebenchOutput> {
      context.signal.throwIfAborted();
      try {
        return await context.withInstance(
          input.candidateRef,
          'inference-endpoint',
          async (execution) => {
            context.signal.throwIfAborted();
            await mkdir(context.directory, { recursive: true });
            const evaluationConfig = prepareEvaluationConfig(config, {
              concurrency: input.concurrency,
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
              result = await runner(
                { configPath, signal: context.signal, env: process.env },
                { context },
              );
            } catch (error) {
              const partial =
                error && typeof error === 'object' && 'result' in error
                  ? error.result
                  : null;
              const diagnostic = object(
                redact({
                  name: error instanceof Error ? error.name : 'Error',
                  message:
                    error instanceof Error ? error.message : String(error),
                  phase:
                    error && typeof error === 'object' && 'phase' in error
                      ? error.phase
                      : null,
                }),
              );
              const { measurementRef, status } = await normalizeEvaluation(
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
                  status,
                },
              );
            }
            const { measurementRef, status } = await normalizeEvaluation(
              evaluationConfig,
              input,
              execution,
              result,
              context,
            );
            if (status !== 'succeeded' && status !== 'failed')
              throw Object.assign(new Error(`Evaluator outcome: ${status}`), {
                measurementRef,
                status,
              });
            return { measurementRef };
          },
        );
      } catch (error) {
        if (
          !(error instanceof OperationRejectedError) ||
          context.signal.aborted
        )
          throw error;
        await context.charge('evaluationRuns', 1);
        const { measurementRef } = await normalizeEvaluation(
          null,
          input,
          {},
          null,
          context,
          { phase: 'startup', message: errorText(error) },
        );
        return { measurementRef };
      }
    },
    async dispose(): Promise<void> {},
  };
}

export function prepareEvaluationConfig(
  rawConfig: unknown,
  {
    execution,
    directory,
    concurrency,
  }: {
    execution: JsonObject;
    directory: string;
    concurrency?: number;
  },
): SdkEvaluatorConfig {
  const config = object(rawConfig, 'evaluator config');
  const prepared = object(structuredClone(config));
  const benchmark: JsonObject =
    typeof prepared.benchmark === 'string'
      ? { name: prepared.benchmark }
      : object(prepared.benchmark, 'benchmark');
  if (concurrency !== undefined) {
    const settings = object(benchmark.config ?? {}, 'benchmark.config');
    benchmark.config = {
      ...settings,
      workload: {
        ...object(settings.workload ?? {}, 'benchmark.config.workload'),
        concurrency,
      },
    };
  }
  const solver: JsonObject =
    typeof benchmark.solver === 'string'
      ? { name: benchmark.solver }
      : plain(benchmark.solver);
  const serviceName = string(
    solver.service ?? 'default',
    'benchmark.solver.service',
  );
  const services: JsonObject =
    prepared.services === undefined
      ? { default: {} }
      : object(prepared.services, 'services');
  if (!Object.hasOwn(services, serviceName))
    throw new Error(
      `services.${serviceName} must be declared for the selected solver service`,
    );
  const service = object(services[serviceName], `services.${serviceName}`);
  for (const field of ['model', 'base_url', 'api_key']) {
    if (Object.hasOwn(service, field))
      throw new Error(
        `services.${serviceName}.${field} is supplied by the Application`,
      );
  }
  service.model = string(execution.model, 'inference model');
  service.base_url = string(execution.baseUrl, 'inference baseUrl');
  if (typeof execution.credentialRef === 'string')
    service.api_key = execution.credentialRef.startsWith('${')
      ? execution.credentialRef
      : `\${${execution.credentialRef}}`;
  prepared.services = services;
  prepared.output = {
    ...plain(prepared.output),
    directory: join(directory, 'sdk'),
  };
  const parsed = parseEvaluatorConfig(prepared);
  if (benchmark.name !== 'agentx' && benchmark.name !== 'aisbench')
    throw new Error(
      'inferencebench requires benchmark.name=agentx or aisbench',
    );
  const environment =
    typeof parsed.environment === 'string'
      ? parsed.environment
      : parsed.environment?.name;
  if (
    parsed.deployment !== undefined ||
    (environment !== undefined && environment !== 'local')
  )
    throw new Error('Owned inference service requires local execution');
  if (plain(config.output).directory !== undefined)
    throw new Error('output.directory is owned by RSI');
  return parsed;
}
