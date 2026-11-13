import type {
  MeasurementSummary,
  ResultReference,
} from '../../api/observation-client.js';

/** Use only returned references; scores and ordering never select a winner; explicit deliveries take precedence over history. */
export function finalResults(
  references: readonly ResultReference[],
  measurements: readonly MeasurementSummary[],
): {
  candidates: string[];
  scores: { measurement: MeasurementSummary; paths: string[] }[];
  missingMeasurements: string[];
} {
  // Built-in Policies return deliveries at these explicit top-level paths.
  // Their baseline and search-history references are evidence, not deliveries.
  const deliveryPaths = new Set([
    '/candidateRef',
    '/measurementRef',
    '/testMeasurementRef',
    '/bestCandidateRef',
    '/bestMeasurementRef',
    '/finalMeasurementRef',
  ]);
  const explicit = references.filter((reference) =>
    deliveryPaths.has(reference.path),
  );
  const deliveries = explicit.length ? explicit : references;
  const returned = new Map<string, string[]>();
  for (const reference of deliveries) {
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
        : deliveries
            .filter((reference) => reference.kind === 'candidate')
            .map((reference) => reference.ref),
    ),
  ];
  return { candidates, scores, missingMeasurements };
}
