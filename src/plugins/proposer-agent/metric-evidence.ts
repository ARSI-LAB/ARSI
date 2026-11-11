import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';

/** Only public Measurement metrics/definitions; never copy private native result files. */
export async function metricEvidence(
  refs: readonly string[],
  context: RuntimeContext,
): Promise<JsonObject> {
  const definitions: JsonObject = {};
  const measurements: JsonObject[] = [];
  for (const ref of new Set(refs)) {
    const measurement = await context.readMeasurement(ref);
    const metrics = object(measurement.metrics ?? {});
    for (const raw of Object.values(metrics)) {
      const metric = object(raw);
      const definitionRef = string(metric.definitionRef);
      if (!definitions[definitionRef])
        definitions[definitionRef] =
          await context.artifacts.readJson(definitionRef);
    }
    measurements.push({
      measurementRef: ref,
      candidateRef: measurement.candidateRef ?? null,
      status: measurement.status ?? 'unknown',
      coverage: measurement.coverage ?? 'unknown',
      comparisonKey: measurement.comparisonKey ?? null,
      metrics,
    });
  }
  return { measurements, metricDefinitions: definitions };
}
