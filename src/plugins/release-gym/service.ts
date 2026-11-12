import type {
  JsonObject,
  Operation,
  ReleaseInput,
  ReleaseOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { activateCandidate } from '../shared/gym/activation.js';
import {
  expandGymEnvironment,
  resolveGymActivation,
} from '../shared/gym/config.js';
import {
  gymReleaseAttemptKey,
  readGymReleaseAttempt,
  writeGymReleaseAttempt,
  type GymReleaseAttemptStatus,
} from './attempt.js';
import {
  GymPromotionClient,
  GymPromotionError,
  type GymPromotionOutcome,
  type GymPromotionReport,
} from './client.js';
import type { GymReleaseConfig, GymReleaseMetric } from './schema.js';

interface ResolvedReleaseConfig extends GymReleaseConfig {
  minDelta: number;
  metric: GymReleaseMetric;
}

interface RoleResult {
  ref: string;
  digest: string;
  outcome: GymPromotionOutcome;
}

type RoleName = 'candidate' | 'incumbent';

interface Comparison {
  decision: 'promote' | 'keep-incumbent' | 'reject';
  reason: string;
  reasons: string[];
  delta: number | null;
  metric: GymReleaseMetric;
  candidateValue: number | null;
  incumbentValue: number | null;
}

export function resolveReleaseConfig(
  config: GymReleaseConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedReleaseConfig {
  return {
    ...config,
    baseUrl: expandGymEnvironment(config.baseUrl, 'baseUrl', environment),
    minDelta: config.minDelta ?? 0,
    metric: config.metric ?? 'successRate',
    activation: resolveGymActivation(config.activation, environment),
  };
}

export async function createGymRelease(
  config: GymReleaseConfig,
  _context: RuntimeContext,
  schema: JsonObject,
): Promise<Operation<ReleaseInput, ReleaseOutput>> {
  validate(schema, config, 'gym release config');
  const settings = resolveReleaseConfig(config);
  const client = new GymPromotionClient({
    baseUrl: settings.baseUrl,
    ...(settings.poll === undefined ? {} : settings.poll),
  });

  return {
    async execute(input, context): Promise<ReleaseOutput> {
      const source = object(input, 'gym release input');
      const candidateRef = string(
        source.candidateRef,
        'gym release input.candidateRef',
      );
      const incumbentRef = string(
        source.incumbentRef,
        'gym release input.incumbentRef',
      );
      context.signal.throwIfAborted();

      const attemptKey = gymReleaseAttemptKey(
        candidateRef,
        incumbentRef,
        releaseFingerprint(settings),
      );
      const promotionRoles: RoleName[] = [];
      const persistAttempt = (
        status: GymReleaseAttemptStatus,
        retryable: boolean,
        error: string | null,
      ) =>
        writeGymReleaseAttempt(context.facts, {
          schemaVersion: 'rsi.gym-release-attempt/v1',
          key: attemptKey,
          candidateRef,
          incumbentRef,
          status,
          retryable,
          promotionRoles: [...promotionRoles],
          error,
          updatedAt: new Date().toISOString(),
        });

      await persistAttempt('running', true, null);
      try {
        const candidate = await evaluateRole(
          'candidate',
          candidateRef,
          settings,
          client,
          context,
          async () => {
            if (!promotionRoles.includes('candidate'))
              promotionRoles.push('candidate');
            await persistAttempt('submitting', true, null);
          },
        );
        const candidateIssues = reportIssues(candidate, 'candidate', settings);
        const incumbent =
          candidateRef === incumbentRef
            ? candidate
            : candidateIssues.length === 0
              ? await evaluateRole(
                  'incumbent',
                  incumbentRef,
                  settings,
                  client,
                  context,
                  async () => {
                    if (!promotionRoles.includes('incumbent'))
                      promotionRoles.push('incumbent');
                    await persistAttempt('submitting', true, null);
                  },
                )
              : null;
        const comparison = compare(
          candidate,
          incumbent,
          candidateIssues,
          settings,
        );

        const record = {
          schemaVersion: 'rsi.gym-release/v1',
          generatedAt: new Date().toISOString(),
          decision: comparison.decision,
          reason: comparison.reason,
          reasons: comparison.reasons,
          metric: comparison.metric,
          minDelta: settings.minDelta,
          candidate: summarize(candidate, 'candidate', settings),
          incumbent:
            incumbent === null
              ? null
              : summarize(incumbent, 'incumbent', settings),
          comparison:
            comparison.delta === null
              ? null
              : {
                  metric: comparison.metric,
                  candidateValue: comparison.candidateValue,
                  incumbentValue: comparison.incumbentValue,
                  delta: comparison.delta,
                  minDelta: settings.minDelta,
                },
        };
        const releaseRef = await context.artifacts.putJson(record);

        const chosenRef =
          comparison.decision === 'promote' ? candidateRef : incumbentRef;
        await activateChosen(chosenRef, settings, context);
        await persistAttempt('completed', false, null);
        return {
          decision: comparison.decision,
          reason: comparison.reason,
          releaseRef,
        };
      } catch (error) {
        const retryable = failureRetryable(error, promotionRoles);
        await persistAttempt('failed', retryable, errorText(error)).catch(
          () => undefined,
        );
        const failure = await restoreIncumbentOnFailure(
          candidateRef,
          incumbentRef,
          settings,
          context,
          error,
        );
        throw failure;
      }
    },
    async canRetry(input, _receipt, context): Promise<boolean> {
      try {
        const source = object(input, 'gym release input');
        const candidateRef = string(
          source.candidateRef,
          'gym release input.candidateRef',
        );
        const incumbentRef = string(
          source.incumbentRef,
          'gym release input.incumbentRef',
        );
        const attempt = await readGymReleaseAttempt(
          context.facts,
          gymReleaseAttemptKey(
            candidateRef,
            incumbentRef,
            releaseFingerprint(settings),
          ),
        );
        return attempt?.retryable === true;
      } catch {
        return false;
      }
    },
    async dispose(): Promise<void> {},
  };
}

async function evaluateRole(
  role: RoleName,
  ref: string,
  settings: ResolvedReleaseConfig,
  client: GymPromotionClient,
  context: RuntimeContext,
  onPromotion: () => Promise<void>,
): Promise<RoleResult> {
  context.signal.throwIfAborted();
  return context.withInstance(
    ref,
    'agentbundle',
    async (execution) => {
      context.signal.throwIfAborted();
      const digest = string(
        execution.bundleDigest,
        `${role} execution.bundleDigest`,
      );
      const directory =
        typeof execution.directory === 'string' ? execution.directory : null;
      if (settings.activation !== undefined) {
        if (directory === null)
          throw new Error(
            `${role} activation requires the acquired bundle directory`,
          );
        await activateCandidate(
          settings.activation,
          context,
          ref,
          directory,
          digest,
        );
      }
      await onPromotion();
      const defaults = settings.promotionDefaults;
      const outcome = await client.promote(
        {
          candidateId: ref,
          candidateDigest: digest,
          adapter: defaults.adapter,
          benchmark: defaults.benchmark,
          seed: defaults.seed,
          ...(defaults.datasetVersion === undefined
            ? {}
            : { datasetVersion: defaults.datasetVersion }),
          ...(defaults.budget === undefined ? {} : { budget: defaults.budget }),
        },
        context.signal,
        {
          onAccepted: async ({ reused }) => {
            if (!reused) await context.charge('evaluationRuns', 1);
          },
        },
      );
      return { ref, digest, outcome };
    },
    { instanceKey: role },
  );
}

async function activateChosen(
  ref: string,
  settings: ResolvedReleaseConfig,
  context: RuntimeContext,
): Promise<void> {
  if (settings.activation === undefined) return;
  await context.withInstance(
    ref,
    'agentbundle',
    async (execution) => {
      const digest = string(
        execution.bundleDigest,
        'release activation execution.bundleDigest',
      );
      const directory = string(
        execution.directory,
        'release activation execution.directory',
      );
      await activateCandidate(
        settings.activation,
        context,
        ref,
        directory,
        digest,
      );
    },
    { instanceKey: 'activate' },
  );
}

async function restoreIncumbentOnFailure(
  candidateRef: string,
  incumbentRef: string,
  settings: ResolvedReleaseConfig,
  context: RuntimeContext,
  cause: unknown,
): Promise<unknown> {
  if (settings.activation === undefined || candidateRef === incumbentRef)
    return cause;
  const restoreContext = context.extend({
    signal: AbortSignal.timeout(30_000),
  });
  try {
    await activateChosen(incumbentRef, settings, restoreContext);
    return cause;
  } catch (restoreError) {
    return new AggregateError(
      [cause, restoreError],
      'gym release failed and the incumbent could not be restored',
    );
  }
}

function failureRetryable(error: unknown, roles: readonly RoleName[]): boolean {
  if (error instanceof GymPromotionError)
    return error.details.submitted || error.details.outcomeUnknown;
  return roles.length > 0;
}

function reportIssues(
  role: RoleResult,
  label: string,
  settings: ResolvedReleaseConfig,
): string[] {
  const issues: string[] = [];
  if (role.outcome.state !== 'completed')
    issues.push(
      `${label} promotion state is ${role.outcome.state}${
        role.outcome.errorMessage === null
          ? ''
          : `: ${role.outcome.errorMessage}`
      }`,
    );
  const report = role.outcome.report;
  if (report === null) {
    issues.push(`${label} promotion produced no report`);
    return issues;
  }
  if (report.status !== 'completed')
    issues.push(`${label} report status is ${report.status}`);
  if (report.split !== 'holdout')
    issues.push(`${label} report is not a holdout report`);
  if (report.candidateDigest !== role.digest)
    issues.push(`${label} report candidate_digest does not match the bundle`);
  if (report.benchmark !== settings.promotionDefaults.benchmark)
    issues.push(`${label} report benchmark does not match the release config`);
  if (report.adapter !== settings.promotionDefaults.adapter)
    issues.push(`${label} report adapter does not match the release config`);
  if (report.tier !== 'full')
    issues.push(`${label} report tier is ${report.tier}, not full`);
  if (report.seed === null) issues.push(`${label} report has no seed`);
  else if (report.seed !== settings.promotionDefaults.seed)
    issues.push(`${label} report seed does not match the release config`);
  if (report.rollouts === null || report.rollouts < 0)
    issues.push(`${label} report has an invalid rollout count`);
  if (report.rolloutsFailed === null || report.rolloutsFailed < 0)
    issues.push(`${label} report has an invalid rollouts_failed count`);
  else if (
    report.rollouts !== null &&
    report.rollouts + report.rolloutsFailed <= 0
  )
    issues.push(`${label} report has no attempted rollouts`);
  if (
    report.passRate !== null &&
    (!Number.isFinite(report.passRate) ||
      report.passRate < 0 ||
      report.passRate > 1)
  )
    issues.push(`${label} report has an invalid pass_rate`);
  if (report.rollouts !== null && report.rollouts > 0) {
    if (report.passRate === null)
      issues.push(`${label} report has no finite pass_rate`);
    if (report.rewardMean === null || !Number.isFinite(report.rewardMean))
      issues.push(`${label} report has no finite reward_mean`);
  }
  for (const [field, value] of [
    ['dataset_version', report.datasetVersion],
    ['manifest_schema_version', report.manifestSchemaVersion],
    ['harness_manifest_digest', report.harnessManifestDigest],
    ['environment_digest', report.environmentDigest],
    ['evaluation_digest', report.evaluationDigest],
    ['experiment_profile_id', report.experimentProfileId],
  ] as const)
    if (value === null) issues.push(`${label} report has no ${field}`);
  return issues;
}

function effectiveMetric(
  report: GymPromotionReport | null,
  metric: GymReleaseMetric,
): number | null {
  if (report === null) return null;
  const successful = report.rollouts;
  const failed = report.rolloutsFailed;
  if (successful === null || failed === null) return null;
  const attempted = successful + failed;
  if (attempted <= 0) return null;
  if (successful === 0) return 0;
  const value = metric === 'successRate' ? report.passRate : report.rewardMean;
  if (value === null) return null;
  return (value * successful) / attempted;
}

function compare(
  candidate: RoleResult,
  incumbent: RoleResult | null,
  candidateIssues: string[],
  settings: ResolvedReleaseConfig,
): Comparison {
  const candidateReport = candidate.outcome.report;
  const candidateValue = effectiveMetric(candidateReport, settings.metric);
  if (candidateIssues.length > 0)
    return {
      decision: 'reject',
      reason: candidateIssues[0]!,
      reasons: candidateIssues,
      delta: null,
      metric: settings.metric,
      candidateValue,
      incumbentValue: null,
    };
  if (incumbent === null)
    return {
      decision: 'reject',
      reason: 'incumbent promotion report is unavailable',
      reasons: ['incumbent promotion report is unavailable'],
      delta: null,
      metric: settings.metric,
      candidateValue,
      incumbentValue: null,
    };

  const incumbentReport = incumbent.outcome.report;
  const incumbentValue = effectiveMetric(incumbentReport, settings.metric);
  const issues = reportIssues(incumbent, 'incumbent', settings);
  if (candidateReport !== null && incumbentReport !== null)
    issues.push(...identityMismatches(candidateReport, incumbentReport));
  const metricLabel =
    settings.metric === 'successRate'
      ? 'effective holdout pass rate'
      : 'effective holdout mean reward';
  if (
    candidateValue === null ||
    incumbentValue === null ||
    !Number.isFinite(candidateValue) ||
    !Number.isFinite(incumbentValue)
  ) {
    const valueIssues = [
      ...issues,
      `holdout reports do not provide a comparable ${metricLabel}`,
    ];
    return {
      decision: 'reject',
      reason: valueIssues[0]!,
      reasons: valueIssues,
      delta: null,
      metric: settings.metric,
      candidateValue,
      incumbentValue,
    };
  }
  if (issues.length > 0)
    return {
      decision: 'reject',
      reason: issues[0]!,
      reasons: issues,
      delta: null,
      metric: settings.metric,
      candidateValue,
      incumbentValue,
    };

  const delta = candidateValue - incumbentValue;
  if (delta > settings.minDelta)
    return {
      decision: 'promote',
      reason: `candidate ${metricLabel} strictly beats incumbent`,
      reasons: [],
      delta,
      metric: settings.metric,
      candidateValue,
      incumbentValue,
    };
  return {
    decision: 'keep-incumbent',
    reason:
      delta === settings.minDelta
        ? `${metricLabel}s are equal; keep the incumbent`
        : `candidate ${metricLabel} does not exceed the release threshold; keep the incumbent`,
    reasons: [],
    delta,
    metric: settings.metric,
    candidateValue,
    incumbentValue,
  };
}

function identityMismatches(
  candidate: GymPromotionReport,
  incumbent: GymPromotionReport,
): string[] {
  const issues: string[] = [];
  for (const [field, left, right] of [
    ['benchmark', candidate.benchmark, incumbent.benchmark],
    ['dataset_version', candidate.datasetVersion, incumbent.datasetVersion],
    ['tier', candidate.tier, incumbent.tier],
    ['seed', candidate.seed, incumbent.seed],
    ['rollouts', candidate.rollouts, incumbent.rollouts],
    [
      'manifest_schema_version',
      candidate.manifestSchemaVersion,
      incumbent.manifestSchemaVersion,
    ],
    [
      'harness_manifest_digest',
      candidate.harnessManifestDigest,
      incumbent.harnessManifestDigest,
    ],
    [
      'environment_digest',
      candidate.environmentDigest,
      incumbent.environmentDigest,
    ],
    [
      'evaluation_digest',
      candidate.evaluationDigest,
      incumbent.evaluationDigest,
    ],
    [
      'experiment_profile_id',
      candidate.experimentProfileId,
      incumbent.experimentProfileId,
    ],
  ] as const) {
    if (left === null || right === null)
      issues.push(`holdout reports have no ${field}`);
    else if (left !== right)
      issues.push(`candidate and incumbent holdout ${field} differ`);
  }
  return issues;
}

function summarize(
  role: RoleResult,
  label: string,
  settings: ResolvedReleaseConfig,
): JsonObject {
  const report = role.outcome.report;
  return {
    role: label,
    candidateRef: role.ref,
    candidateDigest: role.digest,
    promotionId: role.outcome.promotionId,
    promotionState: role.outcome.state,
    reused: role.outcome.reused,
    report:
      report === null
        ? null
        : {
            evalId: report.evalId,
            status: report.status,
            split: report.split,
            tier: report.tier,
            seed: report.seed,
            benchmark: report.benchmark,
            adapter: report.adapter,
            rewardMean: report.rewardMean,
            passRate: report.passRate,
            rollouts: report.rollouts,
            rolloutsFailed: report.rolloutsFailed,
            manifestSchemaVersion: report.manifestSchemaVersion,
            harnessManifestDigest: report.harnessManifestDigest,
            environmentDigest: report.environmentDigest,
            evaluationDigest: report.evaluationDigest,
            experimentProfileId: report.experimentProfileId,
            datasetVersion: report.datasetVersion,
            generatedAt: report.generatedAt,
          },
    errorCode: role.outcome.errorCode,
    errorMessage: role.outcome.errorMessage,
    metric: settings.metric,
    minDelta: settings.minDelta,
  };
}

function releaseFingerprint(settings: ResolvedReleaseConfig): JsonObject {
  return {
    baseUrl: settings.baseUrl,
    adapter: settings.promotionDefaults.adapter,
    benchmark: settings.promotionDefaults.benchmark,
    seed: settings.promotionDefaults.seed,
    datasetVersion: settings.promotionDefaults.datasetVersion ?? null,
    maxRollouts: settings.promotionDefaults.budget?.maxRollouts ?? null,
    timeoutS: settings.promotionDefaults.budget?.timeoutS ?? null,
    minDelta: settings.minDelta,
    metric: settings.metric,
    activation: settings.activation ?? null,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
