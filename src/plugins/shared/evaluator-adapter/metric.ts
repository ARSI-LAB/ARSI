import type { ArtifactStore } from '../../../contracts/index.js';
import { metricDefinitionSchema } from '../../../contracts/models/measurement.js';
import { validate } from '../../../shared/schema.js';
export async function definition(
  artifacts: ArtifactStore,
  id: string,
  unit: string,
  valueKind: 'scalar' | 'distribution',
  mapping: string,
  aggregation: string,
): Promise<string> {
  const value = {
    id,
    description: `Native ${mapping}`,
    unit,
    valueKind,
    version: 1,
    aggregation,
    mapping,
  };
  validate(metricDefinitionSchema, value, 'metric definition');
  return artifacts.putJson(value);
}
