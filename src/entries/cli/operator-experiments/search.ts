import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '../../../contracts/index.js';
import type { Manager } from '../../../runtime/manager/index.js';
import { digest, object, string } from '../../../shared/json.js';
import { reportCampaign, type ExperimentSnapshot } from './campaign.js';

export type SearchConditions = {
  caseId: string;
  sourceDigest: string;
  taskDigest: string;
  protocol: {
    warmup: number;
    repeat: number;
    rtol: number;
    atol: number;
    timingScope: string;
  };
};
export type SearchCalibration = {
  status: 'passed' | 'failed-noise' | 'not-applicable';
  campaignId: string;
  comparisonKey: string | null;
  threshold: number | null;
  reason: string | null;
  evidence: { manifest: JsonObject; report: JsonObject | null } | null;
};

/** Compare measured SDK conditions; search Prompts/Agent settings have a separate identity. */
export function assertSearchConditions(
  measured: {
    sourceDigest: string;
    comparisonKey: string;
    conditions: JsonObject;
  },
  expected: SearchConditions,
): void {
  const conditions = measured.conditions;
  if (
    measured.sourceDigest !== expected.sourceDigest ||
    conditions.mode !== 'sdk' ||
    conditions.taskDigest !== expected.taskDigest ||
    measured.comparisonKey !== digest(conditions)
  )
    throw new Error(
      'Calibration source, task or comparison identity differs from search',
    );
  if (object(object(conditions.evaluation).contract).caseId !== expected.caseId)
    throw new Error('Calibration case differs from search');
  const protocol = object(object(conditions.evaluation).protocol);
  for (const field of [
    'warmup',
    'repeat',
    'rtol',
    'atol',
    'timingScope',
  ] as const)
    if (protocol[field] !== expected.protocol[field])
      throw new Error(`Calibration protocol ${field} differs from search`);
}

/** Calibration is optional confidence evidence, never permission to generate a candidate. */
export async function verifySearchCalibration(options: {
  rootDirectory: string;
  campaignId?: string;
  manager: Manager;
  hostIdentity: string;
  buildDigest: string;
  expected: SearchConditions;
  python: string;
  device: number;
  inspectSnapshot: (manifestPath: string) => Promise<ExperimentSnapshot>;
}): Promise<SearchCalibration | null> {
  if (!options.campaignId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.campaignId))
    throw new Error('Invalid calibration campaign ID');
  const base = join(
    options.rootDirectory,
    '.rsi/operator-calibration',
    options.campaignId,
  );
  const manifest = object(
    JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')),
  );
  const notApplicable = (reason: string): SearchCalibration => ({
    status: 'not-applicable',
    campaignId: options.campaignId!,
    comparisonKey: null,
    threshold: null,
    reason,
    evidence: { manifest, report: null },
  });
  const preflight = object(manifest.preflight);
  if (
    manifest.hostIdentity !== options.hostIdentity ||
    object(preflight.build).digest !== options.buildDigest
  )
    return notApplicable(
      'Calibration host or software build differs from this search',
    );
  const parameters = object(preflight.parameters);
  if (
    parameters.python !== options.python ||
    parameters.device !== options.device
  )
    return notApplicable(
      'Calibration interpreter or device differs from this search',
    );
  if (
    manifest.warmup !== options.expected.protocol.warmup ||
    manifest.repeat !== options.expected.protocol.repeat
  )
    return notApplicable(
      'Calibration timing protocol differs from this search',
    );
  const report = await reportCampaign({
    rootDirectory: options.rootDirectory,
    id: options.campaignId,
    manager: options.manager,
    prepare: async (entry) => {
      const path = join(
        options.rootDirectory,
        '.rsi/operator-sdk',
        entry.id,
        'manifest.json',
      );
      const snapshot = await options.inspectSnapshot(path);
      const raw = object(JSON.parse(await readFile(path, 'utf8')));
      const parameters = object(raw.executionParameters);
      if (
        parameters.python !== options.python ||
        parameters.device !== options.device
      )
        throw new Error(
          'Calibration interpreter or device differs from search',
        );
      return snapshot;
    },
  });
  if (
    report.basicLoop !== 'passed' ||
    !['passed', 'failed-noise'].includes(report.performance) ||
    report.errors.length !== 0 ||
    report.recovery !== 'verified' ||
    report.measurements.length !== 20 ||
    report.statistics?.evidenceKind !== 'device-observed'
  )
    throw new Error(
      `Supplied calibration lacks complete valid real-device evidence; observed ${report.performance}`,
    );
  for (const sample of report.measurements) {
    const measurement = await options.manager.facts.read(
      'measurements',
      sample.measurementRef,
    );
    const conditions = object(
      await options.manager.artifacts.readJson(
        string(object(measurement.conditions).artifactRef),
      ),
    );
    try {
      assertSearchConditions(
        {
          sourceDigest: sample.sourceDigest,
          comparisonKey: sample.comparisonKey,
          conditions,
        },
        options.expected,
      );
    } catch (error) {
      return notApplicable(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const comparisonKey = report.measurements[0]!.comparisonKey;
  return {
    status: report.performance === 'passed' ? 'passed' : 'failed-noise',
    campaignId: options.campaignId,
    comparisonKey,
    threshold: report.statistics.threshold,
    reason:
      report.performance === 'passed'
        ? null
        : 'Calibration noise exceeds the agreed bounds',
    evidence: { manifest, report: object(JSON.parse(JSON.stringify(report))) },
  };
}
function latency(point: JsonObject): number | null {
  const metrics = object(point.metrics);
  const valid = object(metrics.candidateValid);
  if (valid.status !== 'available' || object(valid.value).value !== 1)
    return null;
  const metric = object(metrics.latencyMeanMs);
  if (metric.status !== 'available') return null;
  const value = object(metric.value);
  return value.kind === 'scalar' &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value > 0
    ? value.value
    : null;
}

/** Audit the final same-source pair independently of the Policy's Selector result. */
export function finalTimingStable(
  best: JsonObject | null,
  final: JsonObject | null,
): boolean | null {
  if (
    !best ||
    !final ||
    typeof best.candidateRef !== 'string' ||
    best.candidateRef !== final.candidateRef ||
    typeof best.comparisonKey !== 'string' ||
    !best.comparisonKey ||
    best.comparisonKey !== final.comparisonKey
  )
    return null;
  if (
    typeof object(best.provenance).sourceDigest !== 'string' ||
    object(best.provenance).sourceDigest !==
      object(final.provenance).sourceDigest
  )
    return null;
  const a = latency(best),
    b = latency(final);
  return a === null || b === null
    ? null
    : Math.abs(b - a) / ((a + b) / 2) <= 0.05;
}

/** Observed selection and reliable improvement are separate results. */
export function assessSearchConfidence(
  calibration: SearchCalibration | null,
  baseline: JsonObject | null,
  best: JsonObject | null,
  final: JsonObject | null,
  minRelativeImprovement: number,
): {
  performanceQualified: boolean;
  observedImprovement: boolean;
  improvementStatus: 'verified' | 'pending' | 'not-observed' | 'invalid';
  finalTimingStable: boolean | null;
} {
  const initial = baseline && latency(baseline),
    selected = best && latency(best),
    retested = final && latency(final);
  const stable = finalTimingStable(best, final);
  const comparable =
    baseline?.comparisonKey === best?.comparisonKey &&
    best?.comparisonKey === final?.comparisonKey;
  const observedImprovement = !!(
    initial &&
    selected &&
    baseline?.candidateRef !== best?.candidateRef &&
    baseline?.comparisonKey === best?.comparisonKey &&
    selected < initial * (1 - minRelativeImprovement)
  );
  const valid = !!(initial && selected && retested && comparable);
  const performanceQualified =
    valid &&
    stable === true &&
    calibration?.status === 'passed' &&
    calibration.comparisonKey === best?.comparisonKey;
  const repeatedGain = !!(
    initial &&
    retested &&
    calibration?.threshold != null &&
    retested <
      initial * (1 - Math.max(minRelativeImprovement, calibration.threshold))
  );
  return {
    performanceQualified,
    observedImprovement,
    improvementStatus: !valid
      ? 'invalid'
      : !observedImprovement
        ? 'not-observed'
        : performanceQualified && repeatedGain
          ? 'verified'
          : 'pending',
    finalTimingStable: stable,
  };
}
