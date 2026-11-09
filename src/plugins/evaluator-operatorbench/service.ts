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
import { prepareSdkConfiguration } from './sdk.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { EvaluatorRunError } from 'ember-evaluator';
import { sdkRunner } from '../shared/evaluator-adapter/sdk.js';
import type { PreparedSdkRun } from './sdk.js';
import { adaptSdkResult, type SdkOperatorResult } from './result.js';
import {
  readProfileAssessment,
  recordSdkEvaluateMeasurement,
  recordSdkMeasurement,
  sdkEvaluationStatus,
} from './measurement.js';
import { recordFailedMeasurement, rejectionMessage } from './failure.js';
import {
  configSchema,
  sdkConditionsSchema,
  sdkProvenanceSchema,
  sdkDetailsSchema,
  type OperatorbenchConfig,
} from './schema.js';
import { createMockOperatorbench } from './mock-service.js';

/** The candidate's tiling parameters: config.json (kernel-opt parameters
 * file) or tiling.json, whichever the workspace carries. */
export async function readTiling(
  directory: string,
): Promise<JsonObject | null> {
  for (const name of ['config.json', 'tiling.json']) {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, name), 'utf8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as JsonObject;
    } catch {
      // Absent or unparseable parameters stay null; the digest stays honest.
    }
  }
  return null;
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

export async function createOperatorbench(
  rawConfig: unknown,
  _services: RuntimeContext,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const config = parseConfig<OperatorbenchConfig>(
    configSchema,
    rawConfig,
    'operatorbench config',
  );
  // Fixture-backed mode shares the evaluate contract and measurement shapes
  // so the full kernel-opt chain is verifiable without an Ascend NPU.
  if (config.mode === 'mock') return createMockOperatorbench(config, _services);
  const task = await loadOperatorTask(config.task.directory);
  const adapterDigest = await sourceIdentity(import.meta.url, [
    './service',
    './schema',
    './sdk',
    './result',
    './measurement',
    './failure',
    '../shared/operator-task',
    '../application-kernel/schema',
  ]);
  const sdkBuildDigest = await sdkBuildIdentity();
  return {
    async execute(input, context) {
      validate(
        operatorbenchContract.input_schema,
        input,
        'operatorbench input',
      );
      const selectedCases = input.caseIds.map((id) => {
        const selected = task.cases.find((c) => c.id === id);
        if (!selected) throw new Error(`Unknown SDK operator case ${id}`);
        return selected;
      });
      // Diagnostics compare against a single measured case.
      if (input.action === 'profile' && selectedCases.length !== 1)
        throw new Error('Profile supports exactly one case per call');
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
                caseId: selectedCases[0]!.id,
                seed: selectedCases[0]!.seed,
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
      if (input.action === 'profile')
        return context.withInstance(
          input.candidateRef,
          'kernel-source',
          async (raw) => {
            const execution = parseKernelExecution(raw);
            if (
              assessment &&
              assessment.sourceDigest !== execution.sourceDigest
            )
              throw new Error(
                'Diagnostic source differs from its precision assessment',
              );
            const prepared = await prepareSdkConfiguration(
              config,
              task.definition.contract,
              selectedCases[0]!,
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
                if (
                  key.taskId === selectedCases[0]!.id &&
                  key.runId === native.runId
                )
                  entries = await archiveItemExecution(
                    context,
                    native,
                    selectedCases[0]!.id,
                    string(key.attemptId),
                    null,
                    null,
                  );
              }
              result = adaptSdkResult(
                native,
                prepared,
                config,
                selectedCases[0]!.seed,
              );
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
              selectedCases[0]!.id,
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
            return {
              action: 'profile' as const,
              measurementRef,
              collectionStatus:
                result.profile?.status === 'completed'
                  ? ('completed' as const)
                  : ('unavailable' as const),
            };
          },
        );
      // Evaluate: one charge per call — the policy's budget counts evaluation
      // rounds, not per-case SDK invocations.
      context.signal.throwIfAborted();
      await context.charge('evaluationRuns', 1);
      try {
        return await context.withInstance(
          input.candidateRef,
          'kernel-source',
          async (raw) => {
            // A precheck-rejected candidate arrives as an unverified
            // execution; it is never measured, only recorded. The check must
            // run BEFORE parseKernelExecution: the raw object is the
            // documented rejection shape, not a schema-valid KernelExecution.
            const rejection = rejectionMessage(raw);
            if (rejection !== null) throw new Error(rejection);
            const execution = parseKernelExecution(raw);
            const tiling = await readTiling(execution.directory);
            const perCase: {
              caseId: string;
              result: SdkOperatorResult;
              entries: JsonValue[];
            }[] = [];
            for (const selected of selectedCases) {
              context.signal.throwIfAborted();
              const prepared = await prepareSdkConfiguration(
                config,
                task.definition.contract,
                selected,
                execution,
                context.directory,
                input.action,
              );
              context.signal.throwIfAborted();
              let native: JsonObject = { status: 'not-returned' };
              let result: SdkOperatorResult;
              let entries: JsonValue[] = [];
              try {
                native = object(await runOperatorSdk(prepared, context.signal));
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
                result = adaptSdkResult(
                  native,
                  prepared,
                  config,
                  selected.seed,
                );
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
              perCase.push({ caseId: selected.id, result, entries });
            }
            const conditions = {
              mode: 'sdk',
              taskDigest: task.taskDigest,
              adapterDigest,
              sdkBuildDigest,
              evaluation: null,
            };
            const measurementRef = await recordSdkEvaluateMeasurement(
              perCase,
              input.candidateRef,
              execution,
              conditions,
              context,
              tiling,
            );
            // A recorded non-completed assessment is an evaluation outcome the
            // policy can consume (stale round), not a runner crash.
            const status = sdkEvaluationStatus(perCase);
            // An aborted call is never a policy-consumable outcome; surface
            // the cancellation like the profile path does.
            if (context.signal.aborted)
              throw Object.assign(
                new Error('Operator SDK assessment cancelled'),
                { measurementRef, status },
              );
            return { action: 'evaluate' as const, measurementRef, status };
          },
        );
      } catch (error) {
        // A candidate the lifecycle could not prepare (e.g. the precheck
        // rejected the kernel) is an evaluation outcome, not a runner crash:
        // record a failed measurement so the policy loop counts a stale round
        // and converges instead of dying mid-run with a non-resumable receipt.
        // The catch sits OUTSIDE withInstance because acquire/precheck
        // rejections happen before the closure runs.
        if (context.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return recordFailedMeasurement(input, context, {
          message,
          caseIds: input.caseIds,
          runnerDigest: adapterDigest,
          tiling: null,
          conditions: {
            schemaId: 'rsi.operator-sdk-conditions/v1',
            schema: sdkConditionsSchema,
            value: {
              mode: 'sdk',
              taskDigest: task.taskDigest,
              adapterDigest,
              sdkBuildDigest,
              evaluation: null,
            },
          },
          provenance: {
            schemaId: 'rsi.operator-sdk-provenance/v1',
            schema: sdkProvenanceSchema,
            value: {
              mode: 'sdk',
              sourceDigest: null,
              artifactRef: null,
              runId: null,
              attemptId: null,
              realNpuRuns: null,
              cleanup: 'unknown',
            },
          },
          profile: {
            schemaId: 'rsi.operator-sdk-details/v1',
            schema: sdkDetailsSchema,
            value: {
              mode: 'sdk',
              sourceDigest: null,
              caseId: input.caseIds.join(','),
              assessment: null,
              profile: null,
            },
          },
        });
      }
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
