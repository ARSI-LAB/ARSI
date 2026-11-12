import type { ArtifactStore, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
const agentxUnits: Readonly<Record<string, string>> = {
  ttft: 'ms',
  itl: 'ms',
  requestLatency: 'ms',
  inputThroughput: 'tokens/sec',
  outputThroughput: 'tokens/sec',
  totalThroughput: 'tokens/sec',
  interactivity: 'tokens/sec/user',
  fullResponseInteractivity: 'tokens/sec/user',
  requests: 'requests',
  errors: 'requests',
  duration: 'sec',
  inputTokens: 'tokens',
  outputTokens: 'tokens',
};
export async function agentxMetrics(
  artifacts: ArtifactStore,
  summary: JsonObject,
  sourceRef: string,
): Promise<JsonObject> {
  const metrics: JsonObject = {};
  const profiling = object(summary.profiling, 'AgentX profiling');
  for (const [id, raw] of Object.entries(profiling)) {
    const statistic = raw === null ? {} : object(raw, `AgentX ${id}`);
    const unit =
      raw === null
        ? (agentxUnits[id] ?? null)
        : typeof statistic.unit === 'string'
          ? statistic.unit
          : null;
    if (raw !== null && agentxUnits[id] && unit !== agentxUnits[id])
      throw new Error(`AgentX ${id} unit differs from its metric definition`);
    if (!unit) throw new Error(`AgentX ${id} has no native unit`);
    const definitionRef = await definition(
      artifacts,
      id,
      unit,
      'distribution',
      `profiling.${id}`,
      'single native workload point; no averaging across concurrency points',
    );
    const value: JsonObject = {
      kind: 'distribution',
      count: statistic.count ?? null,
      mean: statistic.mean ?? null,
      p50: statistic.p50 ?? null,
      p95: statistic.p95 ?? null,
      p99: statistic.p99 ?? null,
    };
    const available = ['mean', 'p50', 'p95', 'p99'].some(
      (k) => typeof value[k] === 'number',
    );
    metrics[id] = available
      ? {
          definitionRef,
          status: 'available',
          value,
          source: { artifactRef: sourceRef, pointer: `/profiling/${id}` },
        }
      : {
          definitionRef,
          status: 'unavailable',
          value: null,
          reason: 'Native statistic is missing',
          source: { artifactRef: sourceRef, pointer: `/profiling/${id}` },
        };
  }
  return metrics;
}

// Consume SDK-normalized metrics, without interpreting benchmark-native evidence.
export async function performancePoint(
  artifacts: ArtifactStore,
  envelope: JsonObject | null,
  taskId: string,
): Promise<{ workload: JsonObject; metrics: JsonObject } | null> {
  const result = object(
    object(envelope?.metrics)['aisbench-performance'],
    'SDK performance metrics',
  );
  if (result.applicable !== true || !Array.isArray(result.points))
    throw new Error('SDK performance metrics are missing or not applicable');
  const matches = result.points
    .map((v) => object(v))
    .filter((v) => v.taskId === taskId);
  if (matches.length !== 1)
    throw new Error('SDK performance point is missing or duplicated');
  const point = matches[0]!;
  if (point.status !== 'completed') return null;
  const workload = object(point.workload, 'SDK performance workload');
  const sourceRef = await artifacts.putJson(point);
  const metrics: JsonObject = {};
  for (const [id, raw] of Object.entries(
    object(point.metrics, 'SDK point metrics'),
  )) {
    const metric = object(raw, `SDK metric ${id}`);
    const unit = string(metric.unit, 'SDK metric unit');
    const pointer = string(metric.source, 'SDK metric evidence pointer');
    if (!pointer.startsWith('/'))
      throw new Error('SDK metric evidence must be a JSON pointer');
    const value = metric.value;
    if (
      value !== null &&
      (typeof value !== 'number' || !Number.isFinite(value))
    )
      throw new Error('SDK scalar metric must be finite or null');
    const definitionRef = await definition(
      artifacts,
      id,
      unit,
      'scalar',
      id,
      'single completed workload point; supplied by Evaluator',
    );
    metrics[id] =
      value === null
        ? {
            definitionRef,
            status: 'unavailable',
            value: null,
            reason: 'Native statistic is missing or invalid',
            source: { artifactRef: sourceRef, pointer },
          }
        : {
            definitionRef,
            status: 'available',
            value: { kind: 'scalar', value },
            source: { artifactRef: sourceRef, pointer },
          };
  }
  return { workload, metrics };
}
