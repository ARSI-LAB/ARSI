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
import { parseKernelExecution } from '../application-kernel/schema.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { digest, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { archiveItemExecution } from '../shared/evaluator-adapter/measurement.js';
import { prepareOperatorCase } from './kernel-input.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { EvaluatorRunError } from 'ember-evaluator';
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
import { configSchema, type OperatorbenchConfig } from './schema.js';

export async function createOperatorbench(
  rawConfig: unknown,
  _context: RuntimeContext,
  runner: EvaluatorRunner = sdkRunner,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const config = parseConfig<OperatorbenchConfig>(
    configSchema,
    rawConfig,
    'operatorbench config',
  );
  const taskDirectory = config.task.directory;
  const task = await loadOperatorTask(taskDirectory);
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
      const selected = task.cases.find((c) => c.id === input.caseIds[0]);
      if (!selected) throw new Error('Unknown SDK operator case');
      const manifest = join(context.directory, 'sdk-input', 'manifest.json');
      const evaluationConfig = prepareEvaluationConfig(config, {
        selected,
        operation: input.action,
        directory: context.directory,
        manifest,
      });
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
                taskDigest: task.taskDigest,
                sdkBuildDigest,
                adapterDigest,
                caseId: selected.id,
                seed: selected.seed,
              },
              context,
            )
          : null;
      context.signal.throwIfAborted();
      if (
        (await loadOperatorTask(taskDirectory)).taskDigest !== task.taskDigest
      )
        throw new Error('Operator task changed after loading');
      return context.withInstance(
        input.candidateRef,
        'kernel-source',
        async (raw) => {
          context.signal.throwIfAborted();
          const execution = parseKernelExecution(raw);
          if (assessment && assessment.sourceDigest !== execution.sourceDigest)
            throw new Error(
              'Diagnostic source differs from its precision assessment',
            );
          const prepared = await prepareOperatorCase({
            taskDirectory,
            rawContract: task.definition.contract,
            selected,
            execution,
            manifest,
            operation: input.action,
          });
          const configPath = join(context.directory, 'sdk-config.json');
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
          const conditions = {
            mode: 'sdk',
            taskDigest: task.taskDigest,
            adapterDigest,
            sdkBuildDigest,
            evaluation: result.conditions,
          };
          const measurementRef = await recordSdkMeasurement(
            result,
            input.candidateRef,
            selected.id,
            execution,
            conditions,
            entries,
            context,
            input.action,
          );
          if (result.status !== 'completed' || result.cleanup !== 'confirmed')
            throw Object.assign(
              new Error(`Operator SDK assessment ${result.status}`),
              { measurementRef, status: result.status },
            );
          return input.action === 'profile'
            ? {
                action: 'profile',
                measurementRef,
                collectionStatus:
                  result.profile?.status === 'completed'
                    ? 'completed'
                    : 'unavailable',
              }
            : { action: 'evaluate', measurementRef };
        },
      );
    },
    async dispose(): Promise<void> {},
  };
}

function prepareEvaluationConfig(
  { task: _task, ...config }: OperatorbenchConfig,
  {
    selected,
    operation,
    directory,
    manifest,
  }: {
    selected: { id: string; seed: number };
    operation: OperatorbenchInput['action'];
    directory: string;
    manifest: string;
  },
): SdkEvaluatorConfig {
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
  if (operation === 'profile')
    kernel.profiling = {
      ...plain(kernel.profiling),
      enabled: true,
      cacheEnabled: false,
    };
  const { sampling: _sampling, offset: _offset, ...run } = plain(config.run);
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
  return digest(files.sort((a, b) => a.path.localeCompare(b.path)));
}
