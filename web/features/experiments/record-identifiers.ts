import type { MeasurementSummary } from '../../api/observation-client.js';

/** A display abbreviation of the real ID, never a generation or ordering label. */
export function candidateLabel(ref: string): string {
  const marker = ref.lastIndexOf('candidate-');
  const token = marker < 0 ? ref : ref.slice(marker + 'candidate-'.length);
  return `C-${token.length <= 10 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`}`;
}
/** Number the complete experiment's recorded evaluations before any view filtering. */
export function evaluationOrdinals(
  measurements: readonly MeasurementSummary[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const measurement of [...measurements].sort(
    (a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
      a.ref.localeCompare(b.ref),
  ))
    if (!result.has(measurement.ref))
      result.set(measurement.ref, result.size + 1);
  return result;
}
// Display precision only; recorded values remain unchanged.
export function scoreLabel(value: number): string {
  return (Math.abs(value) < 0.005 ? 0 : value).toLocaleString(undefined, {
    notation: 'standard',
    maximumFractionDigits: 2,
  });
}
