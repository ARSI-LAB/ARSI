import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { environmentSummarySchema } from '../../contracts/models/measurement.js';
import { validate } from '../../shared/schema.js';
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
    const environments = [];
    for (const raw of Array.isArray(measurement.extensions)
      ? measurement.extensions
      : []) {
      const extension = object(raw);
      if (extension.schemaId !== 'measurement.environment-summary/v1') continue;
      const summary = await context.artifacts.readJson(
        string(extension.artifactRef),
      );
      validate(
        environmentSummarySchema,
        summary,
        'Measurement environment summary',
      );
      environments.push({ artifactRef: extension.artifactRef, summary });
    }
    measurements.push({
      measurementRef: ref,
      candidateRef: measurement.candidateRef ?? null,
      status: measurement.status ?? 'unknown',
      coverage: measurement.coverage ?? 'unknown',
      comparisonKey: measurement.comparisonKey ?? null,
      metrics,
      environments,
    });
  }
  return { measurements, metricDefinitions: definitions };
}
