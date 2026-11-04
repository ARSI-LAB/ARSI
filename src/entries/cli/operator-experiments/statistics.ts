export type CalibrationMeasurement = {
  measurementRef: string;
  experimentId: string;
  runId: string;
  comparisonKey: string;
  sourceDigest: string;
  batch: number;
  candidateMs: number;
  referenceMs: number;
  warmup: number;
  repeat: number;
  fixture: boolean;
};
export type MetricStatistics = {
  mean: number;
  median: number;
  cv: number;
  batchCvs: number[];
  batchMedians: number[];
  drift: number;
  pairDifferences: number[];
  passed: boolean;
};
export type CalibrationStatistics = {
  passed: boolean;
  numericallyStable: boolean;
  evidenceKind: 'device-observed' | 'test-fixture';
  candidate: MetricStatistics;
  reference: MetricStatistics;
  noise: number | null;
  threshold: number | null;
};
const mean = (values: number[]): number =>
  values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2;
};
const cv = (values: number[]): number => {
  const average = mean(values);
  return (
    Math.sqrt(
      values.reduce((sum, n) => sum + (n - average) ** 2, 0) /
        (values.length - 1),
    ) / average
  );
};
function statistics(values: number[]): MetricStatistics {
  const batches = [values.slice(0, 10), values.slice(10)];
  const batchCvs = batches.map(cv),
    batchMedians = batches.map(median);
  const drift =
    Math.abs(batchMedians[1] - batchMedians[0]) / mean(batchMedians);
  const pairDifferences = Array.from({ length: 10 }, (_, i) => {
    const a = values[2 * i],
      b = values[2 * i + 1];
    return Math.abs(a - b) / ((a + b) / 2);
  });
  const variation = cv(values);
  return {
    mean: mean(values),
    median: median(values),
    cv: variation,
    batchCvs,
    batchMedians,
    drift,
    pairDifferences,
    passed:
      variation <= 0.03 &&
      batchCvs.every((n) => n <= 0.03) &&
      drift <= 0.03 &&
      pairDifferences.every((n) => n <= 0.05),
  };
}
export function summarizeCalibration(
  measurements: CalibrationMeasurement[],
): CalibrationStatistics {
  if (measurements.length !== 20)
    throw new Error('Calibration requires exactly 20 ordered measurements');
  const first = measurements[0];
  for (const field of ['measurementRef', 'runId'] as const)
    if (new Set(measurements.map((m) => m[field])).size !== 20)
      throw new Error(`Duplicate ${field}`);
  const experiments = new Set<string>();
  measurements.forEach((m, i) => {
    if (
      !m.measurementRef ||
      !m.runId ||
      !m.experimentId ||
      !m.comparisonKey ||
      !m.sourceDigest ||
      m.comparisonKey !== first.comparisonKey ||
      m.sourceDigest !== first.sourceDigest ||
      m.warmup !== first.warmup ||
      m.repeat !== first.repeat ||
      !(
        (m.warmup === 5 && m.repeat === 20) ||
        (m.warmup === 10 && m.repeat === 100)
      ) ||
      m.batch !== (i < 10 ? 1 : 2) ||
      [m.candidateMs, m.referenceMs].some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error('Invalid or incompatible calibration measurement');
    if (i % 2) {
      if (m.experimentId !== measurements[i - 1].experimentId)
        throw new Error('Unpaired calibration experiment');
    } else {
      if (experiments.has(m.experimentId))
        throw new Error('Repeated calibration experiment');
      experiments.add(m.experimentId);
    }
  });
  const candidate = statistics(measurements.map((m) => m.candidateMs));
  const reference = statistics(measurements.map((m) => m.referenceMs));
  const fixture = measurements.some((m) => m.fixture);
  const numericallyStable = candidate.passed && reference.passed;
  const passed = numericallyStable && !fixture;
  const noise = passed ? Math.max(...candidate.pairDifferences) : null;
  return {
    passed,
    numericallyStable,
    evidenceKind: fixture ? 'test-fixture' : 'device-observed',
    candidate,
    reference,
    noise,
    threshold: noise === null ? null : Math.max(0.05, 2 * noise),
  };
}
