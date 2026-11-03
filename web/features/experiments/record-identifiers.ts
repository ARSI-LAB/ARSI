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
/** Exact values for selected evaluations and details; chart annotations may be rounded. */
export function exactScoreLabel(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 21 });
}
export function scoreLabel(value: number): string {
  if (value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e7)) {
    const text = value.toExponential(3);
    return (Number(text) === value ? '' : '≈') + text;
  }
  const rounded = Number(value.toPrecision(7));
  return (
    (rounded === value ? '' : '≈') +
    value.toLocaleString(undefined, { maximumSignificantDigits: 7 })
  );
}
