import type {
  CallSummary,
  MeasurementSummary,
  MetricRecord,
} from '../../../api/observation-client.js';
import { candidateLabel, evaluationOrdinals } from '../record-identifiers.js';
type ChartMeasurement = MeasurementSummary &
  Partial<Pick<MetricRecord, 'item'>>;
function scopeKey(record: ChartMeasurement): string {
  return record.item
    ? JSON.stringify([
        record.item.subjectKind,
        record.item.subjectId,
        record.item.parametersRef,
      ])
    : 'aggregate';
}
export interface ScorePoint {
  observationKey: string;
  itemId: string | null;
  sequence: number;
  measurementRef: string;
  callId: string;
  candidateRef: string;
  candidateLabel: string;
  startedAt: string | null;
  value: number | null;
  reason: string | null;
}
export interface ScoreGroup {
  scopeKey: string;
  subject: string;
  key: string;
  name: string;
  definitionRef: string;
  unit: string;
  comparisonKey: string | null;
  coverage: string;
  statistics: string[];
  comparable: boolean;
}
function ordered(measurements: ChartMeasurement[]): ChartMeasurement[] {
  return [...measurements].sort(
    (a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
      a.ref.localeCompare(b.ref),
  );
}
function groupKey(
  measurement: ChartMeasurement,
  metric: MeasurementSummary['metrics'][number],
): string {
  return JSON.stringify([
    scopeKey(measurement),
    metric.name,
    metric.definitionRef,
    metric.unit,
    measurement.comparisonKey,
    measurement.coverage,
  ]);
}
const statistics = ['value', 'mean', 'p50', 'p95', 'p99'];
export function scoreGroups(measurements: ChartMeasurement[]): ScoreGroup[] {
  const groups = new Map<string, ScoreGroup>();
  for (const measurement of ordered(measurements)) {
    for (const metric of measurement.metrics) {
      const key = groupKey(measurement, metric);
      const group: ScoreGroup = groups.get(key) ?? {
        key,
        scopeKey: scopeKey(measurement),
        subject: measurement.item
          ? `${measurement.item.subjectKind}: ${measurement.item.subjectId}`
          : 'Overall result',
        name: metric.name,
        definitionRef: metric.definitionRef,
        unit: metric.unit,
        comparisonKey: measurement.comparisonKey,
        coverage: measurement.coverage,
        statistics: [],
        comparable:
          measurement.comparisonKey !== null &&
          measurement.coverage === 'complete',
      };
      for (const statistic of statistics)
        if (statistic in metric.values && !group.statistics.includes(statistic))
          group.statistics.push(statistic);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    statistics: group.statistics.length
      ? statistics.filter((name) => group.statistics.includes(name))
      : ['value'],
  }));
}
export function scorePoints(
  measurements: ChartMeasurement[],
  group: ScoreGroup,
  statistic: string,
  evaluations: readonly MeasurementSummary[] = measurements,
): ScorePoint[] {
  const ordinals = evaluationOrdinals(evaluations);
  return ordered(measurements).flatMap((measurement) => {
    const metric = measurement.metrics.find(
      (item) => groupKey(measurement, item) === group.key,
    );
    if (
      !metric &&
      (scopeKey(measurement) !== group.scopeKey ||
        measurement.comparisonKey !== group.comparisonKey ||
        measurement.coverage !== group.coverage ||
        measurement.metrics.some((item) => item.name === group.name))
    )
      return [];
    const raw = metric?.values[statistic];
    const valid =
      measurement.status === 'succeeded' &&
      metric?.status === 'available' &&
      typeof raw === 'number' &&
      Number.isFinite(raw);
    const sequence = ordinals.get(measurement.ref);
    if (sequence === undefined)
      throw new Error('Evaluation metadata is incomplete.');
    return [
      {
        observationKey: JSON.stringify([
          measurement.ref,
          measurement.item?.id ?? null,
        ]),
        itemId: measurement.item?.id ?? null,
        sequence,
        measurementRef: measurement.ref,
        callId: measurement.callId,
        candidateRef: measurement.candidateRef,
        candidateLabel: candidateLabel(measurement.candidateRef),
        startedAt: measurement.startedAt,
        value: valid ? raw : null,
        reason: valid
          ? null
          : (metric?.reason ??
            (!metric
              ? 'Metric not recorded'
              : measurement.status !== 'succeeded'
                ? `Measurement ${measurement.status}`
                : `${statistic} not recorded`)),
      },
    ];
  });
}
export interface CallDuration {
  sequence: number;
  callId: string;
  pluginId: string;
  status: string;
  seconds: number | null;
  reason: string | null;
}
export function callDurations(calls: CallSummary[]): CallDuration[] {
  return [...calls]
    .sort(
      (a, b) =>
        (a.startedAt ?? '\uffff').localeCompare(b.startedAt ?? '\uffff') ||
        a.callId.localeCompare(b.callId),
    )
    .map((call, index) => {
      const start = call.startedAt === null ? NaN : Date.parse(call.startedAt);
      const end = call.finishedAt === null ? NaN : Date.parse(call.finishedAt);
      const valid =
        Number.isFinite(start) && Number.isFinite(end) && end >= start;
      return {
        sequence: index + 1,
        callId: call.callId,
        pluginId: call.pluginId,
        status: call.status,
        seconds: valid ? (end - start) / 1000 : null,
        reason: valid
          ? null
          : call.finishedAt === null
            ? 'No recorded finish time'
            : 'Missing or invalid timestamps',
      };
    });
}
