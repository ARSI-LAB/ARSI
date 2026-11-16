import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JsonObject,
  JsonValue,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  kernelBundleDigest,
  parseKernelExecution,
} from '../application-kernel/schema.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
  type OperatorbenchRetry,
  type OperatorbenchToleranceInput,
} from '../../contracts/plugin-types/operatorbench.js';
import { digest, object, string } from '../../shared/json.js';
import { compareFilePaths } from '../../shared/paths.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { archiveItemExecution } from '../shared/evaluator-adapter/measurement.js';
import { prepareOperatorCase } from './kernel-input.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import {
  canModifyTargetFile,
  parseTarget,
} from '../shared/file-application/target.js';
import {
  EvaluatorRunError,
  KERNEL_DTYPE_TOLERANCES,
  resolveTolerance,
} from 'ember-evaluator';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';
import {
  parseEvaluatorConfig,
  type SdkEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { adaptSdkResult, type SdkOperatorResult } from './result.js';
import { profileConditions, readProfileAssessment } from './conditions.js';
import { recordSdkMeasurement } from './measurement.js';
import {
  operatorbenchConfigSchema,
  type OperatorbenchConfig,
} from './schema.js';

const DEFAULT_TOLERANCE = { rtol: 0.001, atol: 0.001, safetyFactor: 10 };

/** The configured pair is the preflight's first attempt; a dtype retry follows only on mismatch. */
export function configuredTolerance(
  rawConfig: unknown,
): OperatorbenchToleranceInput {
  const config = object(rawConfig, 'operatorbench config');
  const benchmark =
    typeof config.benchmark === 'string'
      ? {}
      : plain(object(config.benchmark).config ?? {});
  const tolerance =
    benchmark.tolerance === undefined
      ? {}
      : plain(object(benchmark.tolerance, 'tolerance config'));
  const numeric = (value: unknown, fallback: unknown, name: string): number => {
    const selected = value === undefined ? fallback : value;
    if (
      typeof selected !== 'number' ||
      !Number.isFinite(selected) ||
      selected < 0
    )
      throw new Error(`${name} must be finite and nonnegative`);
    return selected;
  };
  return {
    mode: 'explicit',
    rtol: numeric(tolerance.rtol, benchmark.rtol, 'tolerance.rtol'),
    atol: numeric(tolerance.atol, benchmark.atol, 'tolerance.atol'),
    safetyFactor: numeric(
      tolerance.safetyFactor,
      DEFAULT_TOLERANCE.safetyFactor,
      'tolerance.safetyFactor',
    ),
  };
}

export function dtypeTolerance(dtype: string): OperatorbenchToleranceInput {
  const value =
    KERNEL_DTYPE_TOLERANCES[dtype] ?? KERNEL_DTYPE_TOLERANCES.float32!;
  return { mode: 'dtype', rtol: value.rtol, atol: value.atol };
}

function normalizeRetry(
  retry: OperatorbenchRetry | undefined,
): OperatorbenchRetry {
  return {
    maxAttempts: retry?.maxAttempts ?? 1,
    backoffMs: retry?.backoffMs ?? 0,
  };
}

async function backoff(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function createOperatorbench(
  rawConfig: unknown,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const config = parseConfig<OperatorbenchConfig>(
    operatorbenchConfigSchema,
    rawConfig,
    'operatorbench config',
  );
  const taskDirectory = config.task.directory;
  const { cases, taskDigest } = await loadOperatorTask(taskDirectory);
  const adapterDigest = await sourceIdentity(import.meta.url, [
    './service',
    './schema',
    './kernel-input',
    './conditions',
    './result',
    './measurement',
    './measurement-schema',
    '../shared/operator-task',
    '../shared/evaluator-adapter/configuration',
    '../shared/evaluator-adapter/data',
    '../application-kernel/schema',
    '../../shared/paths',
  ]);
  const sdkBuildDigest = await sdkBuildIdentity();
  return {
    async execute(input, context): Promise<OperatorbenchOutput> {
      validate(
        operatorbenchContract.input_schema,
        input,
        'operatorbench input',
      );
      if (input.caseIds.length !== 1)
        throw new Error('M1 SDK supports exactly one case per call');
      const selected = cases.find((c) => c.id === input.caseIds[0]);
      if (!selected) throw new Error('Unknown SDK operator case');
      const manifest = join(context.directory, 'sdk-input', 'manifest.json');
      // Reject invalid bound config before acquiring a candidate or charging the budget.
      prepareEvaluationConfig(config, {
        selected,
        operation: input.action,
        directory: context.directory,
        manifest,
        tolerance:
          input.action === 'evaluate' ? (input.tolerance ?? null) : null,
      });
      const retry = normalizeRetry(input.infraRetry);
      if ((await sdkBuildIdentity()) !== sdkBuildDigest)
        throw new Error(
          'Operator SDK build changed after loading; start a new experiment',
        );
      const assessment =
        input.action === 'profile'
          ? await readProfileAssessment(
              input.assessmentMeasurementRef,
              input.candidateRef,
              {
                taskDigest,
                sdkBuildDigest,
                adapterDigest,
                caseId: selected.id,
                seed: selected.seed,
              },
              context,
            )
          : null;
      context.signal.throwIfAborted();
      const task = await loadOperatorTask(taskDirectory);
      if (task.taskDigest !== taskDigest)
        throw new Error('Operator task changed after loading');
      return context.withInstance(
        input.candidateRef,
        'kernel-source',
        async (raw) => {
          context.signal.throwIfAborted();
          const execution = parseKernelExecution(raw);
          const sourceBundleDigest = kernelBundleDigest(
            execution.sourcePath,
            execution.sourceFiles,
          );
          if (
            assessment &&
            assessment.sourceBundleDigest !== sourceBundleDigest
          )
            throw new Error(
              'Diagnostic source differs from its precision assessment',
            );
          const target = parseTarget(
            (await context.applicationMetadata()).target,
          );
          const prepared = await prepareOperatorCase({
            task,
            selected,
            execution,
            manifest,
            operation: input.action,
            editablePaths: execution.sourceFiles
              .map((file) => file.path)
              .filter((path) => canModifyTargetFile(target, path)),
          });
          const configPath = join(context.directory, 'sdk-config.json');
          const attempt = async (
            operation: 'evaluate' | 'profile' | 'precision',
            tolerance?: OperatorbenchToleranceInput | null,
          ): Promise<{ result: SdkOperatorResult; entries: JsonValue[] }> => {
            const evaluationConfig = prepareEvaluationConfig(config, {
              selected,
              operation,
              directory: context.directory,
              manifest,
              tolerance,
            });
            await writeFile(configPath, JSON.stringify(evaluationConfig), {
              mode: 0o600,
            });
            context.signal.throwIfAborted();
            await context.charge('evaluationRuns', 1);
            let native: JsonObject = { status: 'not-returned' };
            let result: SdkOperatorResult;
            let entries: JsonValue[] = [];
            try {
              try {
                native = object(
                  await runner({
                    configPath,
                    signal: context.signal,
                    env: {
                      ...process.env,
                      RSI_KERNEL_REPLAY_NO_MODEL_KEY:
                        'not-a-secret-no-model-calls',
                    },
                  }),
                );
              } catch (error) {
                if (
                  !(error instanceof EvaluatorRunError) ||
                  error.result === null
                )
                  throw error;
                native = {
                  ...object(error.result),
                  exitCode: error.exitCode,
                  sdkFailure: { phase: error.phase, message: error.message },
                };
              }
              if ((await sdkBuildIdentity()) !== sdkBuildDigest)
                throw new Error('Operator SDK build changed during execution');
              const snapshot = object(native.snapshot);
              if (
                Array.isArray(snapshot.records) &&
                snapshot.records.length === 1
              ) {
                const key = object(object(snapshot.records[0]).key);
                if (key.taskId === selected.id && key.runId === native.runId)
                  entries = await archiveItemExecution(
                    context,
                    native,
                    selected.id,
                    string(key.attemptId),
                    null,
                    null,
                  );
              }
              result = adaptSdkResult(native, prepared);
              if (assessment && result.status === 'completed')
                result.conditions = profileConditions(result, assessment);
            } catch (error) {
              result = {
                status: context.signal.aborted ? 'cancelled' : 'unknown',
                cleanup: 'unknown',
                valid: null,
                native,
                assessment: null,
                conditions: null,
                profile: null,
                candidateMs: null,
                referenceMs: null,
                speedup: null,
                timing: null,
                errorStats: null,
                tolerance: null,
                infrastructure: null,
                runId: typeof native.runId === 'string' ? native.runId : null,
                attemptId: null,
                diagnostics: [
                  {
                    code: 'SDK_ASSESSMENT_UNCONFIRMED',
                    message: (error instanceof Error
                      ? error.message
                      : String(error)
                    ).slice(0, 4000),
                  },
                ],
              };
            }
            return { result, entries };
          };
          const run = async (
            operation: 'evaluate' | 'profile' | 'precision',
            tolerance?: OperatorbenchToleranceInput | null,
          ): Promise<{ result: SdkOperatorResult; entries: JsonValue[] }> => {
            let last: {
              result: SdkOperatorResult;
              entries: JsonValue[];
            } | null = null;
            for (let index = 1; index <= retry.maxAttempts; index++) {
              if (index > 1) await backoff(retry.backoffMs, context.signal);
              context.signal.throwIfAborted();
              last = await attempt(operation, tolerance);
              const retryable = last.result.infrastructure?.retryable === true;
              if (
                !retryable ||
                index >= retry.maxAttempts ||
                context.signal.aborted
              )
                break;
            }
            return last!;
          };
          const record = async (
            result: SdkOperatorResult,
            entries: JsonValue[],
            operation: 'evaluate' | 'profile' | 'preflight',
          ): Promise<string> => {
            const conditions = {
              mode: 'sdk',
              taskDigest,
              adapterDigest,
              sdkBuildDigest,
              evaluation: result.conditions,
            };
            return recordSdkMeasurement(
              result,
              input.candidateRef,
              selected.id,
              {
                artifactRef: execution.artifactRef,
                sourceDigest: prepared.candidateSha256,
                sourceBundleDigest,
              },
              conditions,
              entries,
              context,
              operation,
            );
          };
          if (input.action === 'profile') {
            const { result, entries } = await run('profile');
            const measurementRef = await record(result, entries, 'profile');
            if (result.cleanup === 'unknown')
              throw Object.assign(
                new Error(`Operator SDK assessment ${result.status}`),
                {
                  measurementRef,
                  status: result.status,
                  code: result.infrastructure?.code ?? null,
                  retryable: false,
                },
              );
            context.signal.throwIfAborted();
            return {
              action: 'profile',
              measurementRef,
              collectionStatus:
                result.profile?.status === 'completed'
                  ? 'completed'
                  : 'unavailable',
            };
          }
          if (input.action === 'preflight') {
            const explicit = configuredTolerance(config);
            const dtype = dtypeTolerance(prepared.contract.output.dtype);
            let last: {
              result: SdkOperatorResult;
              entries: JsonValue[];
            } | null = null;
            let used = explicit;
            let attempts = 0;
            let infrastructure = false;
            for (const tolerance of [explicit, dtype]) {
              attempts++;
              last = await run('precision', tolerance);
              used = tolerance;
              if (last.result.infrastructure !== null) {
                infrastructure = true;
                break;
              }
              if (
                last.result.status !== 'completed' ||
                last.result.valid === true
              )
                break;
            }
            const result = last!.result;
            const measurementRef = await record(
              result,
              last!.entries,
              'preflight',
            );
            if (infrastructure)
              return {
                action: 'preflight',
                measurementRef,
                evaluationStatus: 'infrastructure-error',
                valid: false,
                tolerance: result.tolerance,
                frozenTolerance: null,
                errorStats: result.errorStats,
                attempts,
                suggestedTolerance: null,
                diagnostic: null,
              };
            if (result.status !== 'completed' || result.cleanup === 'unknown')
              throw Object.assign(
                new Error(`Operator SDK assessment ${result.status}`),
                {
                  measurementRef,
                  status: result.status,
                  code: null,
                  retryable: false,
                },
              );
            context.signal.throwIfAborted();
            const valid = result.valid === true;
            const tolerance =
              result.tolerance ??
              resolveTolerance(prepared.contract.output.dtype, {
                mode: used.mode === 'dtype' ? 'dtype' : 'explicit',
                rtol: used.rtol,
                atol: used.atol,
                safetyFactor:
                  used.safetyFactor ?? DEFAULT_TOLERANCE.safetyFactor,
              });
            return {
              action: 'preflight',
              measurementRef,
              evaluationStatus: 'completed',
              valid,
              tolerance,
              frozenTolerance: valid
                ? { mode: 'frozen', rtol: tolerance.rtol, atol: tolerance.atol }
                : null,
              errorStats: result.errorStats,
              attempts,
              suggestedTolerance: valid ? null : dtype,
              diagnostic: valid
                ? null
                : {
                    dtype: prepared.contract.output.dtype,
                    errorStats: result.errorStats,
                    suggestedTolerance: dtype,
                  },
            };
          }
          const { result, entries } = await run('evaluate');
          const measurementRef = await record(result, entries, 'evaluate');
          if (result.status !== 'completed' || result.cleanup !== 'confirmed') {
            throw Object.assign(
              new Error(`Operator SDK assessment ${result.status}`),
              {
                measurementRef,
                status: result.status,
                code: result.infrastructure?.code ?? null,
                retryable: result.infrastructure?.retryable ?? false,
              },
            );
          }
          return { action: 'evaluate', measurementRef };
        },
      );
    },
    async dispose(): Promise<void> {},
  };
}

export function prepareEvaluationConfig(
  rawConfig: unknown,
  {
    selected,
    operation,
    directory,
    manifest,
    tolerance = null,
  }: {
    selected: { id: string; seed: number };
    operation: OperatorbenchInput['action'] | 'precision';
    directory: string;
    manifest: string;
    tolerance?: OperatorbenchToleranceInput | null;
  },
): SdkEvaluatorConfig {
  const { task: _task, ...config } = object(rawConfig, 'operatorbench config');
  if (Object.hasOwn(config, 'services'))
    throw new Error('services is owned by RSI for kernel replay');
  const benchmark =
    typeof config.benchmark === 'string'
      ? { name: config.benchmark }
      : object(config.benchmark, 'benchmark');
  const kernel = { ...plain(benchmark.config) };
  const store =
    typeof config.store === 'string'
      ? { name: config.store }
      : plain(config.store);
  const storeConfig = plain(store.config);
  const output = plain(config.output);
  if (benchmark.name !== 'kernel')
    throw new Error('operatorbench requires benchmark.name=kernel');
  if (config.deployment !== undefined)
    throw new Error('operatorbench requires local SDK execution');
  if (store.name !== undefined && store.name !== 'local')
    throw new Error('operatorbench requires a local run store');
  for (const field of ['manifest', 'operation', 'seeds']) {
    if (field in kernel)
      throw new Error(`benchmark.config.${field} is owned by RSI`);
  }
  if (storeConfig.runIndexDirectory !== undefined)
    throw new Error('store.config.runIndexDirectory is owned by RSI');
  if (output.directory !== undefined)
    throw new Error('output.directory is owned by RSI');
  const { sampling: _sampling, offset: _offset, ...run } = plain(config.run);
  if (operation === 'profile')
    kernel.profiling = {
      ...plain(kernel.profiling),
      enabled: true,
      cacheEnabled: false,
    };
  // Preflight measures quality only; profiling would change worker work and timing.
  if (operation === 'precision')
    kernel.profiling = { ...plain(kernel.profiling), enabled: false };
  // A policy preflight freezes its resolved pair; the recipe's configured pair seeds the first attempt.
  if (tolerance !== null && operation !== 'precision')
    kernel.tolerance = {
      mode: 'frozen',
      rtol: tolerance.rtol,
      atol: tolerance.atol,
      safetyFactor: tolerance.safetyFactor ?? DEFAULT_TOLERANCE.safetyFactor,
    };
  if (tolerance !== null && operation === 'precision')
    kernel.tolerance = {
      mode: tolerance.mode,
      rtol: tolerance.rtol,
      atol: tolerance.atol,
      safetyFactor: tolerance.safetyFactor ?? DEFAULT_TOLERANCE.safetyFactor,
    };
  return parseEvaluatorConfig({
    ...config,
    // Kernel replay needs an SDK service declaration but never calls a model.
    services: {
      default: {
        model: 'kernel-replay-no-model',
        base_url: 'http://127.0.0.1:1',
        api_key: '${RSI_KERNEL_REPLAY_NO_MODEL_KEY}',
      },
    },
    benchmark: {
      ...benchmark,
      config: { ...kernel, manifest, operation, seeds: [selected.seed] },
    },
    store: {
      ...store,
      config: {
        ...storeConfig,
        runIndexDirectory: join(directory, 'sdk-index'),
      },
    },
    run: { ...run, taskIds: [selected.id], maxTasks: null },
    output: { ...output, directory: join(directory, 'sdk-output') },
  });
}

async function sdkBuildIdentity(): Promise<string> {
  const directory = fileURLToPath(
    new URL('.', import.meta.resolve('ember-evaluator')),
  );
  const files: { path: string; sha256: string }[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const file of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${file.name}` : file.name;
      if (file.isDirectory()) await walk(path);
      else if (file.isFile())
        files.push({
          path,
          sha256: createHash('sha256')
            .update(await readFile(join(directory, path)))
            .digest('hex'),
        });
      else throw new Error('SDK build identity requires ordinary files');
    }
  };
  await walk('');
  return digest(files.sort(compareFilePaths));
}
