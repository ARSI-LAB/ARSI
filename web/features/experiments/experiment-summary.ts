import type {
  CandidateSummary,
  MeasurementSummary,
  MetricObservation,
} from '../../api/observation-client.js';

export function recordedDuration(
  start: string | null,
  finish: string | null,
): string {
  if (!start) return 'Not recorded';
  if (!finish) return 'Not finished';
  const ms = Date.parse(finish) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return 'Not recorded';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Follow recorded ancestry only. Missing or cyclic links cannot establish a baseline. */
export function rootCandidate(
  ref: string,
  candidates: readonly CandidateSummary[],
): string | null {
  const byRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );
  const seen = new Set<string>();
  let current = byRef.get(ref);
  while (current?.parentRef) {
    if (seen.has(current.ref)) return null;
    seen.add(current.ref);
    current = byRef.get(current.parentRef);
  }
  return current?.ref ?? null;
}

export function comparableBaseline(
  final: MeasurementSummary,
  metric: MetricObservation,
  measurements: readonly MeasurementSummary[],
  candidates: readonly CandidateSummary[],
): MetricObservation | null {
  const root = rootCandidate(final.candidateRef, candidates);
  if (
    !root ||
    root === final.candidateRef ||
    final.status !== 'succeeded' ||
    final.coverage !== 'complete' ||
    !final.comparisonKey
  )
    return null;
  const matching = measurements
    .filter(
      (measurement) =>
        measurement.candidateRef === root &&
        measurement.status === 'succeeded' &&
        measurement.coverage === 'complete' &&
        measurement.comparisonKey === final.comparisonKey,
    )
    .flatMap((measurement) =>
      measurement.metrics.filter(
        (item) =>
          item.name === metric.name &&
          item.unit === metric.unit &&
          item.definitionRef === metric.definitionRef &&
          item.status === 'available',
      ),
    );
  return matching.length === 1 ? matching[0]! : null;
}
