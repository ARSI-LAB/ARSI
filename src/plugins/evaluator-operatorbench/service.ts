import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JsonObject,
  JsonValue,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { parseKernelExecution } from '../shared/file-application/kernel-execution.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { digest, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { archiveItemExecution } from '../shared/evaluator-adapter/measurement.js';
import { prepareSdkConfiguration } from './sdk.js';
import { loadOperatorTask } from '../shared/file-application/kernel-task.js';
import { EvaluatorRunError } from 'ember-evaluator';
import { sdkRunner } from '../shared/evaluator-adapter/sdk.js';
import type { PreparedSdkRun } from './sdk.js';
import { adaptSdkResult, type SdkOperatorResult } from './result.js';
import { readProfileAssessment, recordSdkMeasurement } from './measurement.js';
import { configSchema, type SdkOperatorbenchConfig } from './schema.js';

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

export async function createOperatorbench(
  rawConfig: unknown,
  _services: RuntimeContext,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const config = parseConfig<SdkOperatorbenchConfig>(
    configSchema,
    rawConfig,
    'operatorbench config',
  );
  const task = await loadOperatorTask(config.task.directory);
  const adapterDigest = await sourceIdentity(import.meta.url, [
    './service',
    './schema',
    './sdk',
    './result',
    './measurement',
    '../shared/file-application/kernel-task',
  ]);
  const sdkBuildDigest = await sdkBuildIdentity();
  return {
    async execute(input, context) {
      validate(
        operatorbenchContract.input_schema,
        input,
        'operatorbench input',
      );
      if (input.caseIds.length !== 1)
        throw new Error('M1 SDK supports exactly one case per call');
      const selected = task.cases.find((c) => c.id === input.caseIds[0]);
      if (!selected) throw new Error('Unknown SDK operator case');
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
        (await loadOperatorTask(config.task.directory)).taskDigest !==
        task.taskDigest
      )
        throw new Error('Operator task changed after loading');
      return context.withInstance(
        input.candidateRef,
        'kernel-source',
        async (raw) => {
          const execution = parseKernelExecution(raw);
          if (assessment && assessment.sourceDigest !== execution.sourceDigest)
            throw new Error(
              'Diagnostic source differs from its precision assessment',
            );
          const prepared = await prepareSdkConfiguration(
            config,
            task.definition.contract,
            selected,
            execution,
            context.directory,
            input.action,
          );
          context.signal.throwIfAborted();
          await context.charge('evaluationRuns', 1);
          let native: JsonObject = { status: 'not-returned' };
          let result: SdkOperatorResult;
          let entries: JsonValue[] = [];
          try {
            native = object(await runOperatorSdk(prepared, context.signal));
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
            result = adaptSdkResult(native, prepared, config, selected.seed);
            if (input.action === 'profile' && result.status === 'completed') {
              if (
                digest(result.conditions?.pluginVersions) !==
                  digest(assessment!.conditions.pluginVersions) ||
                digest(result.conditions?.sdkIdentity) !==
                  digest(assessment!.conditions.sdkIdentity)
              )
                throw new Error(
                  'Diagnostic SDK identity differs from its assessment',
                );
              const assessedEnvironment = object(
                assessment!.conditions.environment,
              );
              const replay = object(
                object(result.profile?.metadata ?? {}).replay ?? {},
              );
              if (
                result.profile?.status === 'completed' &&
                digest(replay.environment) !== digest(assessedEnvironment)
              )
                throw new Error(
                  'Diagnostic environment differs from its assessment',
                );
              result.conditions = {
                ...result.conditions,
                operation: 'profile',
                assessmentMeasurementRef: input.assessmentMeasurementRef,
                assessmentComparisonKey: assessment!.comparisonKey,
                environment: assessedEnvironment,
              };
            }
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
    async dispose() {},
  };
}

async function runOperatorSdk(
  prepared: PreparedSdkRun,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return await sdkRunner({
      configPath: prepared.configPath,
      env: { ...process.env, ...prepared.env },
      signal,
    });
  } catch (error) {
    if (!(error instanceof EvaluatorRunError) || error.result === null)
      throw error;
    return {
      ...object(error.result),
      exitCode: error.exitCode,
      sdkFailure: { phase: error.phase, message: error.message },
    };
  }
}
