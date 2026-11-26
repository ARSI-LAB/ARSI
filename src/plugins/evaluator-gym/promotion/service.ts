import { getLogger } from '@logtape/logtape';
import type {
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../../contracts/index.js';
import { string } from '../../../shared/json.js';
import {
  reportTaskPhase,
  reportTaskProgress,
} from '../../../shared/task-progress.js';
import { expandGymEnvironment } from '../internal/config.js';
import {
  GymPromotionClient,
  type GymPromotionOutcome,
  type GymPromotionReport,
} from './client.js';
import type { GymPromotionConfig, GymReleaseMetric } from './schema.js';

const logger = getLogger(['arsi', 'plugin', 'gym']);

interface ResolvedPromotionConfig extends GymPromotionConfig {
  minDelta: number;
  metric: GymReleaseMetric;
}

interface RoleResult {
  ref: string;
  digest: string;
  outcome: GymPromotionOutcome;
}

type RoleName = 'candidate' | 'incumbent';

type GymPromotionInput = {
  candidateRef: string;
  incumbentRef: string;
};

type GymPromotionOutput = {
  decision: 'promote' | 'keep-incumbent' | 'reject';
  reason: string;
  promotionRef: string;
};

interface Comparison {
  decision: 'promote' | 'keep-incumbent' | 'reject';
  reason: string;
  reasons: string[];
  delta: number | null;
  metric: GymReleaseMetric;
  candidateValue: number | null;
  incumbentValue: number | null;
}

export function resolvePromotionConfig(
  config: GymPromotionConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedPromotionConfig {
  return {
    ...config,
    baseUrl: expandGymEnvironment(config.baseUrl, 'baseUrl', environment),
    minDelta: config.minDelta ?? 0,
    metric: config.metric ?? 'successRate',
  };
}

export async function createGymPromotion(
  config: GymPromotionConfig,
  _context: RuntimeContext,
): Promise<Operation<GymPromotionInput, GymPromotionOutput>> {
  const settings = resolvePromotionConfig(config);
  const client = new GymPromotionClient({
    baseUrl: settings.baseUrl,
    ...(settings.poll === undefined ? {} : settings.poll),
  });

  return {
    async execute(input, context): Promise<GymPromotionOutput> {
      const { candidateRef, incumbentRef } = input;
      context.signal.throwIfAborted();

      if (candidateRef === incumbentRef) {
        const reason =
          'candidate did not advance beyond validation; holdout was not run';
        const promotionRef = await context.artifacts.putJson({
          schemaVersion: 'rsi.gym-release/v1',
          generatedAt: new Date().toISOString(),
          decision: 'keep-incumbent',
          reason,
          reasons: [],
          metric: settings.metric,
          minDelta: settings.minDelta,
          candidate: skippedRole('candidate', candidateRef, settings),
          incumbent: skippedRole('incumbent', incumbentRef, settings),
          comparison: null,
          holdoutSkipped: true,
        });
        return { decision: 'keep-incumbent', reason, promotionRef };
      }
      const candidate = await evaluateRole(
        'candidate',
        candidateRef,
        settings,
        client,
        context,
      );
      const candidateIssues = reportIssues(candidate, 'candidate', settings);
      const incumbent =
        candidateIssues.length === 0
          ? await evaluateRole(
              'incumbent',
              incumbentRef,
              settings,
              client,
              context,
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
      const promotionRef = await context.artifacts.putJson(record);

      return {
        decision: comparison.decision,
        reason: comparison.reason,
        promotionRef,
      };
    },
    async dispose(): Promise<void> {},
  };
}

async function evaluateRole(
  role: RoleName,
  ref: string,
  settings: ResolvedPromotionConfig,
  client: GymPromotionClient,
  context: RuntimeContext,
): Promise<RoleResult> {
  context.signal.throwIfAborted();
  return context.withInstance(ref, 'agentbundle', async (execution) => {
    context.signal.throwIfAborted();
    const digest = string(
      execution.bundleDigest,
      `${role} execution.bundleDigest`,
    );
    const directory =
      typeof execution.directory === 'string' ? execution.directory : null;
    const bundleKind =
      typeof execution.bundleKind === 'string' &&
      execution.bundleKind.length > 0
        ? execution.bundleKind
        : null;
    if (directory === null || bundleKind === null)
      throw new Error(
        `${role} evaluation requires the acquired bundle directory and kind so the Gym adapter can install the candidate`,
      );
    const defaults = settings.promotionDefaults;
    reportTaskProgress(
      logger,
      context.callId,
      `submitting ${role} holdout to gym`,
    );
    const outcome = await client.promote(
      {
        candidateId: ref,
        candidateDigest: digest,
        candidateDir: directory,
        candidateKind: bundleKind,
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
        onAccepted: async ({ promotionId, reused }) => {
          reportTaskPhase(
            logger,
            context,
            `waiting for gym ${role} promotion ${promotionId}`,
          );
          if (!reused) await context.charge('evaluationRuns', 1);
        },
        onPending: (promotionId, state) => {
          reportTaskProgress(
            logger,
            context.callId,
            `waiting for gym ${role} promotion ${promotionId} · ${state}`,
          );
        },
      },
    );
    return { ref, digest, outcome };
  });
}

function reportIssues(
  role: RoleResult,
  label: string,
  settings: ResolvedPromotionConfig,
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
  if (
    settings.promotionDefaults.datasetVersion !== undefined &&
    report.datasetVersion !== settings.promotionDefaults.datasetVersion
  )
    issues.push(
      `${label} report dataset_version does not match the release config`,
    );
  if (report.overfitGuardTrusted === false)
    issues.push(`${label} report is untrusted (overfit guard)`);
  for (const warning of report.warnings)
    if (trustWarning(warning))
      issues.push(`${label} report has a trust warning: ${warning}`);
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
    if (settings.metric === 'successRate' && report.passRate === null)
      issues.push(`${label} report has no finite pass_rate`);
    if (
      settings.metric === 'meanReward' &&
      (report.rewardMean === null || !Number.isFinite(report.rewardMean))
    )
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
  const attempted = report.rolloutsAttempted ?? successful + failed;
  if (attempted <= 0) return null;
  if (successful === 0) return 0;
  const value = metric === 'successRate' ? report.passRate : report.rewardMean;
  if (value === null) return null;
  if (report.rolloutsAttempted !== null) return value;
  return (value * successful) / attempted;
}

function trustWarning(warning: string): boolean {
  return (
    /^split_eval_soft_limit_exceeded\b/i.test(warning) ||
    /\btrusted\s*=\s*false\b/i.test(warning)
  );
}

function compare(
  candidate: RoleResult,
  incumbent: RoleResult | null,
  candidateIssues: string[],
  settings: ResolvedPromotionConfig,
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
    // seed is recorded evidence, not experiment identity: Gym deliberately
    // excludes it from the holdout one-shot key. Successful rollout count also
    // varies with infrastructure failures and is normalized by effectiveMetric.
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
  settings: ResolvedPromotionConfig,
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
            rolloutsAttempted: report.rolloutsAttempted,
            overfitGuardTrusted: report.overfitGuardTrusted,
            warnings: [...report.warnings],
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

function skippedRole(
  role: RoleName,
  ref: string,
  settings: ResolvedPromotionConfig,
): JsonObject {
  return {
    role,
    candidateRef: ref,
    candidateDigest: null,
    promotionId: null,
    promotionState: 'skipped',
    reused: false,
    report: null,
    errorCode: null,
    errorMessage: null,
    metric: settings.metric,
    minDelta: settings.minDelta,
  };
}
