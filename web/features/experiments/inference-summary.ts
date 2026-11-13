import type {
  CandidateSummary,
  MeasurementSummary,
} from '../../api/observation-client.js';
import { comparableBaseline } from './experiment-summary.js';
import {
  scoreGroups,
  scorePoints,
  type ScoreGroup,
  type ScorePoint,
} from './charts/metric-data.js';

interface InferenceSummary {
  groups: ScoreGroup[];
  group: ScoreGroup;
  points: ScorePoint[];
  best: ScorePoint;
  measurement: MeasurementSummary;
  baselineValue: number | null;
  change: number | null;
}

/** Compare throughput only within one recorded definition, condition and coverage. */
export function inferenceSummary(
  measurements: MeasurementSummary[],
  candidates: CandidateSummary[],
  condition?: string,
): InferenceSummary | null {
  const groups = scoreGroups(measurements).filter(
    (group) =>
      group.name === 'outputThroughput' &&
      group.comparable &&
      scorePoints(measurements, group, 'value').some(
        (point) => point.value !== null,
      ),
  );
  const group = groups.find((item) => item.key === condition) ?? groups[0];
  if (!group) return null;
  const points = scorePoints(measurements, group, 'value');
  const best = points.reduce<(typeof points)[number] | null>(
    (best, point) =>
      point.value !== null && (best === null || point.value > best.value!)
        ? point
        : best,
    null,
  );
  if (!best) return null;
  const measurement = measurements.find(
    (item) => item.ref === best.measurementRef,
  )!;
  const metric = measurement.metrics.find(
    (item) =>
      item.name === group.name && item.definitionRef === group.definitionRef,
  )!;
  const baseline = comparableBaseline(
    measurement,
    metric,
    measurements,
    candidates,
  );
  const baselineValue = baseline?.values.value ?? null;
  const change =
    baselineValue !== null && baselineValue > 0
      ? ((best.value! - baselineValue) / baselineValue) * 100
      : null;
  return { groups, group, points, best, measurement, baselineValue, change };
}

export function inferenceMetric(
  measurement: MeasurementSummary,
  name: string,
): number | null {
  const metric = measurement.metrics.find((item) => item.name === name);
  return measurement.status === 'succeeded' &&
    metric?.status === 'available' &&
    typeof metric.values.value === 'number'
    ? metric.values.value
    : null;
}
