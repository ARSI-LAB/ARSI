import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { metricsBottleneckSchema, type MetricsBottleneck } from './schema.js';

/** Bind every model evidence value to a measured kernel metric, excluding assumed hardware ratios. */
export function parseMetricsBottleneck(
  raw: unknown,
  profile: JsonObject,
): MetricsBottleneck {
  const result = parseConfig<MetricsBottleneck>(
    metricsBottleneckSchema,
    raw,
    'Metric bottleneck',
  );
  for (const evidence of result.evidence) {
    if (
      !/^\/kernels\/\d+\/metrics\/[^/]+\//.test(evidence.path) ||
      /(?:ub_ratio|core_utilization)/.test(evidence.path)
    )
      throw new Error(
        'Metric bottleneck evidence must reference an observed kernel metric',
      );
    let value: JsonValue = profile;
    for (const encoded of evidence.path.slice(1).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(value)) value = value[Number(key)] ?? null;
      else if (value !== null && typeof value === 'object')
        value = object(value)[key] ?? null;
      else value = null;
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value !== evidence.value
    )
      throw new Error(
        'Metric bottleneck evidence does not match its measured value',
      );
  }
  return result;
}
