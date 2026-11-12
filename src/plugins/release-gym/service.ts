import type {
  JsonObject,
  Operation,
  ReleaseInput,
  ReleaseOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { activateCandidate } from '../evaluator-gym/activation.js';
import {
  expandGymEnvironment,
  resolveGymActivation,
} from '../evaluator-gym/service.js';
import {
  GymPromotionClient,
  type GymPromotionOutcome,
  type GymPromotionReport,
} from './client.js';
import { type GymReleaseConfig } from './schema.js';

interface ResolvedReleaseConfig extends GymReleaseConfig {
  minDelta: number;
}

interface RoleResult {
  ref: string;
  digest: string;
  outcome: GymPromotionOutcome;
}

export function resolveReleaseConfig(
  config: GymReleaseConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedReleaseConfig {
  return {
    ...config,
    baseUrl: expandGymEnvironment(config.baseUrl, 'baseUrl', environment),
    minDelta: config.minDelta ?? 0,
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

      const candidate = await evaluateRole(
        'candidate',
        candidateRef,
        settings,
        client,
        context,
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
                candidatePassRate: comparison.candidatePassRate,
                incumbentPassRate: comparison.incumbentPassRate,
                delta: comparison.delta,
                minDelta: settings.minDelta,
              },
      };
      const releaseRef = await context.artifacts.putJson(record);

      const chosenRef =
        comparison.decision === 'promote' ? candidateRef : incumbentRef;
      await activateChosen(chosenRef, settings, context);
      return {
        decision: comparison.decision,
        reason: comparison.reason,
        releaseRef,
      };
    },
    async canRetry(): Promise<boolean> {
      return true;
    },
    async dispose(): Promise<void> {},
  };
}

async function evaluateRole(
  role: 'candidate' | 'incumbent',
  ref: string,
  settings: ResolvedReleaseConfig,
  client: GymPromotionClient,
  context: RuntimeContext,
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
      await context.charge('evaluationRuns', 1);
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

function effectivePassRate(report: GymPromotionReport | null): number | null {
  if (report === null) return null;
  const successful = report.rollouts;
  const failed = report.rolloutsFailed;
  if (successful === null || failed === null) return null;
  const attempted = successful + failed;
  if (attempted <= 0) return null;
  if (successful === 0) return 0;
  if (report.passRate === null) return null;
  return (report.passRate * successful) / attempted;
}

function compare(
  candidate: RoleResult,
  incumbent: RoleResult | null,
  candidateIssues: string[],
  settings: ResolvedReleaseConfig,
): {
  decision: 'promote' | 'keep-incumbent' | 'reject';
  reason: string;
  reasons: string[];
  delta: number | null;
  candidatePassRate: number | null;
  incumbentPassRate: number | null;
} {
  const candidateReport = candidate.outcome.report;
  const candidatePassRate = effectivePassRate(candidateReport);
  if (candidateIssues.length > 0)
    return {
      decision: 'reject',
      reason: candidateIssues[0]!,
      reasons: candidateIssues,
      delta: null,
      candidatePassRate,
      incumbentPassRate: null,
    };
  if (incumbent === null)
    return {
      decision: 'reject',
      reason: 'incumbent promotion report is unavailable',
      reasons: ['incumbent promotion report is unavailable'],
      delta: null,
      candidatePassRate,
      incumbentPassRate: null,
    };

  const incumbentReport = incumbent.outcome.report;
  const incumbentPassRate = effectivePassRate(incumbentReport);
  const issues = reportIssues(incumbent, 'incumbent', settings);
  if (candidateReport !== null && incumbentReport !== null)
    issues.push(...identityMismatches(candidateReport, incumbentReport));
  if (
    candidatePassRate === null ||
    incumbentPassRate === null ||
    !Number.isFinite(candidatePassRate) ||
    !Number.isFinite(incumbentPassRate)
  ) {
    const rateIssues = [
      ...issues,
      'holdout reports do not provide a comparable effective pass rate',
    ];
    return {
      decision: 'reject',
      reason: rateIssues[0]!,
      reasons: rateIssues,
      delta: null,
      candidatePassRate,
      incumbentPassRate,
    };
  }
  if (issues.length > 0)
    return {
      decision: 'reject',
      reason: issues[0]!,
      reasons: issues,
      delta: null,
      candidatePassRate,
      incumbentPassRate,
    };

  const delta = candidatePassRate - incumbentPassRate;
  if (delta > settings.minDelta)
    return {
      decision: 'promote',
      reason: 'candidate effective holdout pass rate strictly beats incumbent',
      reasons: [],
      delta,
      candidatePassRate,
      incumbentPassRate,
    };
  return {
    decision: 'keep-incumbent',
    reason:
      delta === settings.minDelta
        ? 'holdout effective pass rates are equal; keep the incumbent'
        : 'candidate effective holdout pass rate does not exceed the release threshold; keep the incumbent',
    reasons: [],
    delta,
    candidatePassRate,
    incumbentPassRate,
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
    minDelta: settings.minDelta,
  };
}
