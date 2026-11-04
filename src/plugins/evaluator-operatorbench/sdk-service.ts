import { readProfileAssessment } from './profile-assessment.js';
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
import { parseKernelExecution } from '../../contracts/models/kernel.js';
import { parseFileTree } from '../../contracts/models/file-tree.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { archiveItemExecution } from '../shared/evaluator-adapter/measurement.js';
import { loadOperatorTask } from './task.js';
import { prepareSdkConfiguration } from './sdk-configuration.js';
import { runOperatorSdk } from './sdk-runner.js';
import { adaptSdkResult, type SdkOperatorResult } from './sdk-result.js';
import { recordSdkMeasurement } from './sdk-measurement.js';
import type { SdkOperatorbenchConfig } from './schema.js';

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

export async function createSdkOperatorbench(
  config: SdkOperatorbenchConfig,
  _services: RuntimeContext,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const task = await loadOperatorTask(config.task.directory);
  const adapterDigest = await sourceIdentity(import.meta.url, [
    './service',
    './task',
    './schema',
    './sdk-service',
    './sdk-runner',
    './sdk-configuration',
    './sdk-result',
    './sdk-measurement',
    './profile-assessment',
    './profile-result',
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
              const verifier = entries
                .map((e) => object(e))
                .find((e) => e.kind === 'verifier');
              if (!verifier)
                throw new Error('Missing diagnostic native evidence');
              const tree = parseFileTree(
                await context.artifacts.readJson(string(verifier.artifactRef)),
              );
              const file = tree.files.find(
                (f) => f.path === 'kernel-profile-result.json',
              );
              if (!file)
                throw new Error('Missing native diagnostic result evidence');
              const worker = object(
                JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')),
              );
              const details = object(
                object(
                  object((object(native.snapshot).records as JsonValue[])[0])
                    .verdict,
                ).details,
              );
              if (digest(worker) !== digest(details))
                throw new Error(
                  'Native diagnostic evidence differs from verdict',
                );
              const replay =
                result.profile?.metadata &&
                object(object(result.profile.metadata).replay ?? {});
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
              if (
                result.profile?.status === 'completed' &&
                (!replay ||
                  replay.seed !== selected.seed ||
                  replay.warmup !== (config.sdk.profiling.warmup ?? 25) ||
                  replay.logicalDevice !== 0 ||
                  digest(replay.environment) !== digest(assessedEnvironment))
              )
                throw new Error(
                  'Diagnostic replay environment or input mismatch',
                );
              result.conditions = {
                ...result.conditions,
                operation: 'profile',
                assessmentMeasurementRef: input.assessmentMeasurementRef,
                assessmentComparisonKey: assessment!.comparisonKey,
                environment: assessedEnvironment,
              };
            }
            if (result.status === 'completed' && input.action === 'evaluate') {
              const verifier = entries
                .map((e) => object(e))
                .find((e) => e.kind === 'verifier');
              if (!verifier) throw new Error('Missing SDK verifier evidence');
              const tree = parseFileTree(
                await context.artifacts.readJson(string(verifier.artifactRef)),
              );
              const file = tree.files.find(
                (f) => f.path === 'kernel-result.json',
              );
              if (!file)
                throw new Error('Missing native kernel result evidence');
              const worker = object(
                JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8')),
              );
              if (
                worker.candidateSha256 !== execution.sourceDigest ||
                digest(worker.assessment) !== digest(result.assessment) ||
                worker.candidateMs !== result.candidateMs ||
                worker.referenceMs !== result.referenceMs
              )
                throw new Error(
                  'Native kernel evidence does not match verdict',
                );
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
