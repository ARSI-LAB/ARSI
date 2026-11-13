import type {
  MeasurementSummary,
  MetricObservation,
} from '../../api/observation-client.js';

const primaryNames = [
  'meanReward',
  'score',
  'reward.reward',
  'reward.overall',
  'reward.test_pass_rate',
  'outputThroughput',
];

export function primaryMetric(
  metrics: readonly MetricObservation[],
): MetricObservation | undefined {
  return (
    primaryNames
      .map((name) => metrics.find((metric) => metric.name === name))
      .find((metric) => metric !== undefined) ??
    metrics.find(
      (metric) =>
        metric.status === 'available' &&
        Object.values(metric.values).some((value) => typeof value === 'number'),
    ) ??
    metrics[0]
  );
}

export function metricLabel(
  metric: Pick<MetricObservation, 'name' | 'unit'>,
): string {
  const names: Record<string, string> = {
    meanReward: 'Average score',
    score: 'Score',
    'reward.reward': 'Score',
    'reward.overall': 'Score',
    'reward.test_pass_rate': 'Pass rate',
    outputThroughput: 'Output throughput',
    inputThroughput: 'Input throughput',
    requestThroughput: 'Request throughput',
    totalThroughput: 'Total throughput',
    tpotP90: 'TPOT P90',
    ttftP90: 'TTFT P90',
    requestLatencyP90: 'Request latency P90',
  };
  const label = names[metric.name] ?? metric.name;
  return primaryNames.includes(metric.name) &&
    metric.name !== 'outputThroughput'
    ? label
    : `${label} (${metric.unit})`;
}

export function primaryScore(measurement: MeasurementSummary): number | null {
  const metric = primaryMetric(measurement.metrics);
  return metric && primaryNames.includes(metric.name)
    ? metricValue(measurement, metric)
    : null;
}

export function metricValue(
  measurement: MeasurementSummary,
  selected: Pick<MetricObservation, 'name' | 'unit'>,
): number | null {
  const metric = measurement.metrics.find(
    (item) => item.name === selected.name && item.unit === selected.unit,
  );
  return measurement.status === 'succeeded' &&
    metric?.status === 'available' &&
    typeof metric.values.value === 'number'
    ? metric.values.value
    : null;
}

/** Average each recorded round first so repeated evaluations do not overweight a task. */
export function roundAverage(
  groups: readonly (readonly MeasurementSummary[])[],
): number | null {
  const means = groups.flatMap((group) => {
    const values = group
      .map(primaryScore)
      .filter((value): value is number => value !== null);
    return values.length
      ? [values.reduce((sum, value) => sum + value, 0) / values.length]
      : [];
  });
  return means.length
    ? means.reduce((sum, value) => sum + value, 0) / means.length
    : null;
}
