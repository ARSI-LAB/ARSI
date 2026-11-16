import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';
import { operatorEvidenceSchema } from './schema.js';

export function scalarMetric(metrics: JsonObject, id: string): number | null {
  const entry = metrics[id];
  if (entry === undefined || entry === null) return null;
  const metric = object(entry);
  if (metric.status !== 'available') return null;
  const value = object(metric.value);
  return value.kind === 'scalar' && typeof value.value === 'number'
    ? value.value
    : null;
}

/** Measurement-mode evidence exposes the timing and precision quantities RSI already verified. */
export function measurementProfile(measurement: JsonObject): JsonObject {
  const metrics = object(measurement.metrics);
  const timing: JsonObject = {};
  const precision: JsonObject = {};
  const place = (target: JsonObject, name: string, id: string): void => {
    const value = scalarMetric(metrics, id);
    if (value !== null) target[name] = value;
  };
  place(timing, 'deviceMeanMs', 'latencyMeanMs');
  place(timing, 'hostMeanMs', 'hostMeanMs');
  place(timing, 'endToEndP50Ms', 'endToEndP50Ms');
  place(timing, 'launchCount', 'launchCount');
  place(precision, 'referenceErrorMaxAbs', 'referenceErrorMaxAbs');
  const blocks: JsonObject = {};
  if (Object.keys(timing).length) blocks.timing = timing;
  if (Object.keys(precision).length) blocks.precision = precision;
  if (!Object.keys(blocks).length)
    throw new Error('Measurement evidence exposes no diagnosis metrics');
  return {
    status: 'completed',
    metadata: { evidenceKind: 'measurement' },
    kernels: [{ metrics: blocks }],
  };
}

function finiteValue(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Classify a failed attempt so repairs can target correctness, infrastructure or deadline causes. */
function failureOf(
  measurement: JsonObject,
  details: JsonObject,
): JsonObject | null {
  const infrastructure =
    details.infrastructure === null || details.infrastructure === undefined
      ? null
      : object(details.infrastructure);
  const code =
    typeof infrastructure?.code === 'string' ? infrastructure.code : null;
  const message =
    typeof infrastructure?.message === 'string' ? infrastructure.message : null;
  if (infrastructure !== null)
    return {
      type:
        code !== null && /timeout/i.test(code) ? 'timeout' : 'infrastructure',
      code,
      message,
      retryable: infrastructure.retryable === true,
      checks: [],
    };
  const valid = scalarMetric(object(measurement.metrics), 'candidateValid');
  if (measurement.status === 'succeeded' && valid !== 0) return null;
  if (measurement.status !== 'succeeded')
    return {
      type: 'infrastructure',
      code: null,
      message: null,
      retryable: false,
      checks: [],
    };
  const assessment =
    details.assessment === null || details.assessment === undefined
      ? null
      : object(details.assessment);
  const raw =
    assessment !== null && Array.isArray(assessment.checks)
      ? assessment.checks
      : [];
  const checks = raw
    .map((value) => object(value))
    .filter((check) => check.status === 'failed' || check.status === 'not-run')
    .slice(0, 16)
    .map((check) => ({
      id: String(check.id),
      seed: finiteValue(check.seed) ?? 0,
      call: finiteValue(check.call) ?? 0,
      status: String(check.status),
      message: typeof check.message === 'string' ? check.message : '',
    }));
  return {
    type: 'candidate-invalid',
    code: null,
    message: checks.find((check) => check.message.length)?.message ?? null,
    retryable: false,
    checks,
  };
}

function precisionOf(
  metrics: JsonObject,
  details: JsonObject,
): JsonObject | null {
  const stats =
    details.errorStats === null || details.errorStats === undefined
      ? null
      : object(details.errorStats);
  if (stats === null) {
    const maxAbs = scalarMetric(metrics, 'referenceErrorMaxAbs');
    return maxAbs === null
      ? null
      : {
          count: null,
          maxAbs,
          maxRel: null,
          p50Abs: null,
          p90Abs: null,
          p99Abs: null,
          mismatch: {},
        };
  }
  const mismatch: JsonObject = {};
  for (const [key, value] of Object.entries(stats)) {
    const fraction = finiteValue(value);
    if (key.startsWith('mismatch_') && fraction !== null)
      mismatch[key] = fraction;
  }
  return {
    count: finiteValue(stats.count),
    maxAbs: finiteValue(stats.maxAbs),
    maxRel: finiteValue(stats.maxRel),
    p50Abs: finiteValue(stats.p50Abs),
    p90Abs: finiteValue(stats.p90Abs),
    p99Abs: finiteValue(stats.p99Abs),
    mismatch,
  };
}

function toleranceOf(details: JsonObject): JsonObject | null {
  if (details.tolerance === null || details.tolerance === undefined)
    return null;
  const tolerance = object(details.tolerance);
  const rtol = finiteValue(tolerance.rtol);
  const atol = finiteValue(tolerance.atol);
  if (typeof tolerance.mode !== 'string' || rtol === null || atol === null)
    return null;
  return {
    mode: tolerance.mode,
    rtol,
    atol,
    source: typeof tolerance.source === 'string' ? tolerance.source : null,
    observedMaxAbs: finiteValue(tolerance.observedMaxAbs),
  };
}

function wholeNetOf(metrics: JsonObject): JsonObject | null {
  const candidateP50Ms = scalarMetric(metrics, 'wholeNetP50Ms');
  const offP50Ms = scalarMetric(metrics, 'wholeNetOffP50Ms');
  const reportedDeltaPct = scalarMetric(metrics, 'wholeNetDeltaPct');
  if (candidateP50Ms === null && offP50Ms === null && reportedDeltaPct === null)
    return null;
  const deltaPct =
    reportedDeltaPct ??
    (candidateP50Ms !== null && offP50Ms !== null && offP50Ms > 0
      ? ((candidateP50Ms - offP50Ms) / offP50Ms) * 100
      : null);
  return { candidateP50Ms, offP50Ms, deltaPct };
}

/** Compact, validated evidence view the Proposer can compare across attempts and lanes. */
export function measurementEvidence(
  measurement: JsonObject,
  details: JsonObject,
): JsonObject {
  const metrics = object(measurement.metrics);
  const evidence = {
    schemaVersion: 'rsi.operator-evidence/v1',
    measurementRef: string(measurement.ref),
    status: string(measurement.status),
    coverage: string(measurement.coverage),
    timing: {
      deviceMeanMs: scalarMetric(metrics, 'latencyMeanMs'),
      hostMeanMs: scalarMetric(metrics, 'hostMeanMs'),
      endToEndP50Ms: scalarMetric(metrics, 'endToEndP50Ms'),
      wholeNetP50Ms: scalarMetric(metrics, 'wholeNetP50Ms'),
      launchCount: scalarMetric(metrics, 'launchCount'),
    },
    precision: precisionOf(metrics, details),
    tolerance: toleranceOf(details),
    wholeNet: wholeNetOf(metrics),
    failure: failureOf(measurement, details),
  };
  validate(operatorEvidenceSchema, evidence, 'Operator measurement evidence');
  return evidence;
}
