import type {
  AgentbenchInput,
  AgentbenchOutput,
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string, strings } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { publishCandidate } from '../shared/gym/publish.js';
import {
  expandGymEnvironment,
  gymPublisherFingerprint,
  resolveGymPublisher,
} from '../shared/gym/config.js';
import {
  GymEvaluationClient,
  GymEvaluationError,
  type GymEvalOutcome,
  type GymEvalRequest,
} from './client.js';
import { recordGymMeasurement } from './measurement.js';
import type { GymConfig } from './schema.js';
import {
  gymSubmissionKey,
  readGymSubmission,
  writeGymSubmission,
  type GymSubmission,
  type GymSubmissionStatus,
} from './submission.js';

export function resolveGymConfig(
  config: GymConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GymConfig {
  if (config.publish !== undefined && config.activation !== undefined)
    throw new Error(
      'gym config must set either publish or activation, not both',
    );
  const publish = resolveGymPublisher(
    config.publish ?? config.activation,
    environment,
  );
  const resolved: GymConfig = {
    ...config,
    baseUrl: expandGymEnvironment(config.baseUrl, 'baseUrl', environment),
  };
  delete resolved.activation;
  if (publish === undefined) delete resolved.publish;
  else resolved.publish = publish;
  return resolved;
}

export async function createGym(
  config: GymConfig,
  _context: RuntimeContext,
  schema: JsonObject,
): Promise<Operation<AgentbenchInput, AgentbenchOutput>> {
  validate(schema, config, 'gym evaluator config');
  const settings = resolveGymConfig(config);
  return {
    async execute(input, context): Promise<AgentbenchOutput> {
      const source = object(input, 'gym evaluator input');
      const candidateRef = string(
        source.candidateRef,
        'gym evaluator input.candidateRef',
      );
      const taskIds = strings(source.taskIds, 'gym evaluator input.taskIds');
      if (new Set(taskIds).size !== taskIds.length)
        throw new Error('gym evaluator input.taskIds: duplicate task id');
      const startedAt = new Date().toISOString();
      return context.withInstance(
        candidateRef,
        'agentbundle',
        async (execution): Promise<AgentbenchOutput> => {
          context.signal.throwIfAborted();
          const bundleDigest =
            typeof execution.bundleDigest === 'string' &&
            execution.bundleDigest.length > 0
              ? execution.bundleDigest
              : null;
          if (bundleDigest === null)
            throw new Error(
              'gym evaluation requires a ready AgentBundle instance with bundleDigest',
            );
          const directory =
            typeof execution.directory === 'string'
              ? execution.directory
              : null;
          const bundleKind =
            typeof execution.bundleKind === 'string'
              ? execution.bundleKind
              : undefined;
          if (settings.publish !== undefined && directory === null)
            throw new Error(
              'gym publish requires the acquired bundle directory',
            );

          const key = submissionKey(candidateRef, settings, taskIds);
          const saved = await readGymSubmission(context.facts, key);
          const existing =
            saved?.candidateDigest === bundleDigest ? saved : null;
          await context.charge('evaluationRuns', 1);

          let outcome: GymEvalOutcome | null = null;
          let failure: JsonObject | null = null;
          try {
            if (settings.publish !== undefined)
              await publishCandidate(settings.publish, context, {
                candidateRef,
                directory: directory!,
                bundleDigest,
                ...(bundleKind === undefined ? {} : { bundleKind }),
              });
          } catch (error) {
            failure = failureRecord(error, 'publish');
          }

          if (failure === null) {
            const client = new GymEvaluationClient({
              baseUrl: settings.baseUrl,
              intervalMs: settings.poll?.intervalMs,
              timeoutMs: settings.poll?.timeoutMs,
            });
            try {
              if (existing?.evalId && existing.status !== 'rejected') {
                outcome = await client.awaitResult(
                  existing.evalId,
                  context.signal,
                );
              } else {
                await writeGymSubmission(
                  context.facts,
                  record(
                    key,
                    candidateRef,
                    bundleDigest,
                    settings.baseUrl,
                    'prepared',
                    null,
                    null,
                  ),
                );
                outcome = await client.evaluate(
                  nativeRequest(candidateRef, bundleDigest, taskIds, settings),
                  context.signal,
                  {
                    onSubmitted: async (evalId) => {
                      await writeGymSubmission(
                        context.facts,
                        record(
                          key,
                          candidateRef,
                          bundleDigest,
                          settings.baseUrl,
                          'submitted',
                          evalId,
                          null,
                        ),
                      );
                    },
                  },
                );
              }
              await writeGymSubmission(
                context.facts,
                record(
                  key,
                  candidateRef,
                  bundleDigest,
                  settings.baseUrl,
                  'completed',
                  outcome.evalId,
                  outcome.errorMessage,
                ),
              );
            } catch (error) {
              failure = failureRecord(error, 'execute');
              if (error instanceof GymEvaluationError)
                await writeGymSubmission(
                  context.facts,
                  record(
                    key,
                    candidateRef,
                    bundleDigest,
                    settings.baseUrl,
                    error.details.outcomeUnknown ? 'unknown' : 'rejected',
                    error.details.evalId,
                    error.message,
                  ),
                );
            }
          }

          const result = await recordGymMeasurement(context, {
            candidateRef,
            bundleDigest,
            baseUrl: settings.baseUrl,
            config: settings,
            taskIds,
            outcome,
            failure,
            startedAt,
          });
          if (!result.comparable)
            throw Object.assign(
              new Error(
                typeof failure?.message === 'string'
                  ? `${failure.message} (${result.reason ?? 'Gym produced no comparable measurement'})`
                  : (result.reason ?? 'Gym produced no comparable measurement'),
              ),
              { measurementRef: result.measurementRef, status: result.status },
            );
          return { measurementRef: result.measurementRef };
        },
      );
    },
    async canRetry(input, _receipt, context): Promise<boolean> {
      const source = object(input, 'gym evaluator input');
      const candidateRef = string(
        source.candidateRef,
        'gym evaluator input.candidateRef',
      );
      const taskIds = strings(source.taskIds, 'gym evaluator input.taskIds');
      const existing = await readGymSubmission(
        context.facts,
        submissionKey(candidateRef, settings, taskIds),
      );
      return (
        existing !== null &&
        (existing.status === 'prepared' ||
          existing.status === 'submitted' ||
          existing.status === 'unknown')
      );
    },
    async dispose(): Promise<void> {},
  };
}

function nativeRequest(
  candidateRef: string,
  bundleDigest: string,
  taskIds: string[],
  settings: GymConfig,
): GymEvalRequest {
  const defaults = settings.requestDefaults;
  return {
    candidateId: candidateRef,
    candidateDigest: bundleDigest,
    adapter: defaults.adapter,
    benchmark: defaults.benchmark,
    split: defaults.split,
    tier: defaults.tier,
    seed: defaults.seed,
    taskIds,
    ...(settings.budget === undefined ? {} : { budget: settings.budget }),
    ...(defaults.harnessManifest === undefined
      ? {}
      : { harnessManifest: defaults.harnessManifest }),
  };
}

function submissionKey(
  candidateRef: string,
  settings: GymConfig,
  taskIds: string[],
): string {
  return gymSubmissionKey(candidateRef, settings.baseUrl, {
    adapter: settings.requestDefaults.adapter,
    benchmark: settings.requestDefaults.benchmark,
    split: settings.requestDefaults.split,
    tier: settings.requestDefaults.tier,
    seed: settings.requestDefaults.seed,
    tasks: [...taskIds].sort(),
    maxRollouts: settings.budget?.maxRollouts ?? null,
    timeoutS: settings.budget?.timeoutS ?? null,
    harnessManifest: settings.requestDefaults.harnessManifest ?? null,
    // Keep the legacy key spelling so already-submitted evaluations remain
    // resumable across the activation -> publish rename.
    activation: gymPublisherFingerprint(settings.publish),
  });
}

function record(
  key: string,
  candidateRef: string,
  candidateDigest: string,
  baseUrl: string,
  status: GymSubmissionStatus,
  evalId: string | null,
  error: string | null,
): GymSubmission {
  return {
    schemaVersion: 'rsi.gym-submission/v1',
    key,
    candidateRef,
    candidateDigest,
    baseUrl,
    evalId,
    status,
    error,
    updatedAt: new Date().toISOString(),
  };
}

function failureRecord(error: unknown, phase: string): JsonObject {
  if (error instanceof GymEvaluationError)
    return {
      name: error.name,
      message: error.message,
      phase: error.details.phase,
      evalId: error.details.evalId,
      submitted: error.details.submitted,
      outcomeUnknown: error.details.outcomeUnknown,
    };
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    phase,
    evalId: null,
    submitted: false,
    outcomeUnknown: false,
  };
}
