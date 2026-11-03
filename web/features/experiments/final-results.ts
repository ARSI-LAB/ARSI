import type {
  MeasurementSummary,
  ResultReference,
} from '../../api/observation-client.js';

/** Use only returned references; ordering, score direction and Policy field names do not select a winner. */
export function finalResults(
  references: readonly ResultReference[],
  measurements: readonly MeasurementSummary[],
): {
  candidates: string[];
  scores: { measurement: MeasurementSummary; paths: string[] }[];
  missingMeasurements: string[];
} {
  const returned = new Map<string, string[]>();
  for (const reference of references) {
    if (reference.kind !== 'measurement') continue;
    const paths = returned.get(reference.ref) ?? [];
    paths.push(reference.path);
    returned.set(reference.ref, paths);
  }
  const owned = new Map(
    measurements.map((measurement) => [measurement.ref, measurement]),
  );
  const scores: { measurement: MeasurementSummary; paths: string[] }[] = [];
  const missingMeasurements: string[] = [];
  for (const [ref, paths] of returned) {
    const measurement = owned.get(ref);
    if (measurement) scores.push({ measurement, paths });
    else missingMeasurements.push(ref);
  }
  // A returned measurement identifies its candidate, including nested task deliveries.
  // Other output references may describe baselines rather than delivered versions.
  const candidates = [
    ...new Set(
      returned.size
        ? scores.map(({ measurement }) => measurement.candidateRef)
        : references
            .filter((reference) => reference.kind === 'candidate')
            .map((reference) => reference.ref),
    ),
  ];
  return { candidates, scores, missingMeasurements };
}
