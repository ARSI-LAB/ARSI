import type { MeasurementSummary } from '../../api/observation-client.js';

export function primaryScore(measurement: MeasurementSummary): number | null {
  const metric = ['meanReward', 'score', 'reward.reward']
    .map((name) => measurement.metrics.find((item) => item.name === name))
    .find((item) => item !== undefined);
  return metric?.status === 'available' &&
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
