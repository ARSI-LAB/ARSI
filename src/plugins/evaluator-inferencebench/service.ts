import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InferencebenchInput,
  InferencebenchOutput,
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string, unknownKeys } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { plain, redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import { evaluationStatus } from '../shared/evaluator-adapter/measurement.js';
import {
  parseEvaluatorConfig,
  type SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';
import { normalizeEvaluation } from './measurement.js';
import { configSchema, type EvaluatorConfig } from './schema.js';
export async function createInferencebench(
  config: EvaluatorConfig,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<InferencebenchInput, InferencebenchOutput>> {
  validate(configSchema, config, 'evaluator config');
  return {
    async execute(input, context): Promise<InferencebenchOutput> {
      object(input);
      unknownKeys(input, ['candidateRef'], 'evaluator input');
      string(input.candidateRef);
      return context.withInstance(
        string(input.candidateRef),
        'inference-endpoint',
        async (execution) => {
          context.signal.throwIfAborted();
          await mkdir(context.directory, { recursive: true });
          const evaluationConfig = prepareEvaluationConfig(config, {
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

export function prepareEvaluationConfig(
  rawConfig: unknown,
  {
    execution,
    directory,
  }: {
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
  if (benchmark.name !== 'agentx')
    throw new Error('inferencebench requires benchmark.name=agentx');
  const environment =
    typeof parsed.environment === 'string'
      ? parsed.environment
      : parsed.environment?.name;
  if (
    parsed.deployment !== undefined ||
    (environment !== undefined && environment !== 'local')
  )
    throw new Error('Owned inference service requires local AgentX execution');
  if (plain(config.output).directory !== undefined)
    throw new Error('output.directory is owned by RSI');
  return parsed;
}
