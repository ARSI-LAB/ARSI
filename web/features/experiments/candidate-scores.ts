import type { MeasurementSummary } from '../../api/observation-client.js';
import {
  scoreGroups,
  scorePoints,
  type ScoreGroup,
  type ScorePoint,
} from './charts/metric-data.js';
import { primaryMetric } from './measurement-score.js';

/** Inference evaluations share a workload rather than training/validation stage labels. */
export function candidateScores(
  measurements: MeasurementSummary[],
  validationRefs: ReadonlySet<string>,
): { group: ScoreGroup | undefined; scores: Map<string, ScorePoint> } {
  const preferred = primaryMetric(measurements.flatMap((item) => item.metrics));
  const validation = measurements.filter((item) =>
    validationRefs.has(item.ref),
  );
  const records =
    preferred?.name === 'outputThroughput' || !validation.length
      ? measurements
      : validation;
  const name = primaryMetric(records.flatMap((item) => item.metrics))?.name;
  const groups = scoreGroups(records).filter((item) => item.name === name);
  const group =
    groups.find(
      (item) =>
        item.comparable &&
        scorePoints(records, item, 'value', measurements).some(
          (point) => point.value !== null,
        ),
    ) ?? groups[0];
  const statistic = group?.statistics.includes('value')
    ? 'value'
    : (group?.statistics[0] ?? 'value');
  return {
    group,
    scores: new Map(
      group
        ? scorePoints(records, group, statistic, measurements).map((point) => [
            point.candidateRef,
            point,
          ])
        : [],
    ),
  };
}
