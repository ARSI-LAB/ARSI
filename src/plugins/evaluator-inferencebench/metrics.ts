import type { ArtifactStore, JsonObject } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import { aisbenchWorkloadSchema } from './measurement-schema.js';
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

const aisbenchFields = [
  ['requestThroughput', 'qps', 'requests/sec'],
  ['inputThroughput', 'input_token_throughput', 'tokens/sec'],
  ['outputThroughput', 'output_throughput', 'tokens/sec'],
  ['totalThroughput', 'E2E_throughput', 'tokens/sec'],
  ['ttftP90', 'TTFT P90', 'ms'],
  ['tpotP90', 'TPOT SLO_P90', 'ms'],
  ['requestLatencyP90', 'E2EL P90', 'ms'],
] as const;

function aisbenchNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function aisbenchPoint(
  artifacts: ArtifactStore,
  summary: JsonObject,
  run: JsonObject,
  taskId: string,
): Promise<{ workload: JsonObject; metrics: JsonObject }> {
  const source = object(run.source, 'AISBench source');
  const provenance = object(run.solverProvenance, 'AISBench provenance');
  const workload = object(summary.workload, 'AISBench workload');
  validate(aisbenchWorkloadSchema, workload, 'AISBench workload');
  const bundleDigest = string(summary.bundleDigest, 'AISBench bundle digest');
  const aisbenchVersion = string(summary.aisbenchVersion, 'AISBench version');
  if (
    summary.schemaVersion !== 1 ||
    summary.kind !== 'aisbench' ||
    source.source !== 'github:rayn-zzz/aisbench_auto_tools_prefix' ||
    !/^[a-f0-9]{64}$/.test(bundleDigest) ||
    bundleDigest !== object(source.metadata).bundleDigest ||
    bundleDigest !== provenance.bundleDigest ||
    aisbenchVersion !== provenance.aisbenchVersion
  )
    throw new Error('AISBench summary source or solver provenance mismatch');
  if (taskId !== `aisbench-${digest(workload).slice(-16)}`)
    throw new Error('AISBench summary workload differs from the selected task');
  const rows = summary.rows;
  if (!Array.isArray(rows) || !rows.length)
    throw new Error('AISBench CSV rows are missing');
  const rowIndex = rows.length - 1;
  const row = object(rows[rowIndex], 'AISBench final CSV row');
  if (
    aisbenchNumber(row.total_req) !== workload.dataCount ||
    (aisbenchNumber(row.qps) ?? 0) <= 0
  )
    throw new Error(
      'AISBench final CSV row must cover the workload and report positive qps',
    );
  const sourceRef = await artifacts.putJson(summary);
  const metrics: JsonObject = {};
  for (const [id, column, unit] of aisbenchFields) {
    const definitionRef = await definition(
      artifacts,
      id,
      unit,
      'scalar',
      `AISBench rows.final.${column}`,
      'single completed workload point; final native CSV row only',
    );
    const value = aisbenchNumber(row[column]);
    const source = Object.hasOwn(row, column)
      ? { artifactRef: sourceRef, pointer: `/rows/${rowIndex}/${column}` }
      : null;
    metrics[id] =
      value !== null
        ? {
            definitionRef,
            status: 'available',
            value: { kind: 'scalar', value },
            source,
          }
        : {
            definitionRef,
            status: 'unavailable',
            value: null,
            reason: 'Native AISBench column is missing or invalid',
            source,
          };
  }
  return { metrics, workload };
}
