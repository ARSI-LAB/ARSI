import type {
  CallEventInfo,
  CallProgressUpdate,
  ExperimentEventInfo,
  ExperimentFinishedEvent,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';

export type CallStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

type TerminalStatus = ExperimentFinishedEvent['status'];

export interface ReusedCallSummary {
  readonly bindingId: string;
  readonly path: string;
  readonly contractId?: string;
  readonly durationMs?: number;
}

export interface RunFinishedProgress {
  readonly kind: 'experiment-finished';
  readonly experimentId: string;
  readonly status: TerminalStatus;
  readonly reused: boolean;
  readonly usage: Readonly<Record<string, number>>;
  readonly candidateRef?: string;
  readonly measurementRef?: string;
  readonly partial: boolean;
  readonly stopReason?: string;
  readonly budgetMetric?: string;
}

export type RunProgress =
  | (ExperimentEventInfo & { readonly kind: 'experiment-preparing' })
  | {
      readonly kind: 'experiment-resumed';
      readonly experimentId: string;
      readonly reusedCalls: readonly ReusedCallSummary[];
      readonly priorUsage: Readonly<Record<string, number>>;
    }
  | (CallEventInfo & {
      readonly kind: 'call';
      readonly contractId: string;
      readonly status: CallStatus;
      readonly summary?: string;
      readonly verboseSummary?: string;
      readonly error?: string;
    })
  | ({
      readonly kind: 'call-progress';
      readonly callId: string;
      readonly parentCallId: string;
      readonly bindingId: string;
      readonly path: string;
      readonly contractId: string;
    } & CallProgressUpdate)
  | {
      readonly kind: 'revision-activated';
      readonly activationId: string;
      readonly bindingIds: readonly string[];
    }
  | { readonly kind: 'step-completed'; readonly stepPath: string }
  | {
      readonly kind: 'iteration-completed';
      readonly stepPath: string;
      readonly iteration: number;
    }
  | { readonly kind: 'experiment-cleaning' }
  | RunFinishedProgress;

export type RunProgressReporter = (event: RunProgress) => void;
export type RunProgressObserver = (event: RunProgress) => void | Promise<void>;

/** Progress observers never participate in dispatch, admission, or the run outcome. */
export function progressReporter(
  observe: RunProgressObserver | undefined,
): RunProgressReporter | undefined {
  if (!observe) return undefined;
  return (event) => {
    try {
      const pending = observe(structuredClone(event));
      if (pending) void pending.catch(() => {});
    } catch {
      // Reporting is best effort.
    }
  };
}

function shortRef(ref: string): string {
  const dash = ref.indexOf('-');
  if (dash > 0 && ref.length - dash - 1 > 10) {
    return `${ref.slice(0, dash + 1)}${ref.slice(dash + 1, dash + 9)}`;
  }
  return ref.length > 20 ? `${ref.slice(0, 17)}…` : ref;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01)
    return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return value.toPrecision(3);
}

const defaultMetricLimit = 4;

const preferredMetricKeys = [
  'successRate',
  'meanReward',
  'passRate',
  'reward',
  'score',
  'accuracy',
  'speedupVsReference',
  'latencyMeanMs',
  'candidateValid',
  'referenceMeanMs',
  'outputThroughput',
  'totalThroughput',
  'ttft',
  'itl',
  'requestLatency',
  'speedup',
  'throughput',
  'latency',
];

function extractMetricValue(entry: JsonValue | undefined): number | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return undefined;
  if (entry.status !== 'available') return undefined;
  const val = entry.value;
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  if (val.kind === 'scalar' && typeof val.value === 'number') return val.value;
  if (val.kind === 'distribution') {
    for (const key of ['mean', 'p50', 'p95', 'p99'] as const) {
      if (typeof val[key] === 'number') return val[key];
    }
  }
  return undefined;
}

export interface MeasurementSummary {
  readonly compact: string;
  readonly full: string;
}

export function summarizeMeasurementDetails(
  measurement: JsonObject,
  limit = defaultMetricLimit,
): MeasurementSummary | undefined {
  const metrics =
    measurement.metrics &&
    typeof measurement.metrics === 'object' &&
    !Array.isArray(measurement.metrics)
      ? measurement.metrics
      : undefined;
  const metricParts: string[] = [];
  if (metrics) {
    const keys = Object.keys(metrics);
    const ordered = [
      ...preferredMetricKeys.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !preferredMetricKeys.includes(key)),
    ];
    for (const key of ordered) {
      const value = extractMetricValue(metrics[key]);
      if (value === undefined) continue;
      metricParts.push(`${key}=${formatNumber(value)}`);
    }
  }
  const suffix: string[] = [];
  if (
    typeof measurement.coverage === 'string' &&
    measurement.coverage !== 'complete'
  ) {
    suffix.push(`coverage=${measurement.coverage}`);
  }
  if (
    typeof measurement.status === 'string' &&
    measurement.status !== 'succeeded'
  ) {
    suffix.push(`status=${measurement.status}`);
  }
  if (metricParts.length === 0 && suffix.length === 0) return undefined;

  const compactMetrics =
    metricParts.length > limit
      ? [...metricParts.slice(0, limit), '…']
      : metricParts;
  return {
    compact: [...compactMetrics, ...suffix].join(' · '),
    full: [...metricParts, ...suffix].join(' · '),
  };
}

export function summarizeMeasurement(
  measurement: JsonObject,
  limit = defaultMetricLimit,
): string | undefined {
  return summarizeMeasurementDetails(measurement, limit)?.compact;
}

export function summarizeCallOutcome(
  contractId: string,
  input: JsonValue,
  output: JsonValue,
  measurementSummary?: string,
): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return measurementSummary;
  }
  if (contractId === 'contract.selector-metrics') {
    const accepted = output.accepted === true;
    const metric = typeof output.metric === 'string' ? output.metric : '';
    const inc =
      typeof output.incumbentValue === 'number'
        ? formatNumber(output.incumbentValue)
        : undefined;
    const cand =
      typeof output.candidateValue === 'number'
        ? formatNumber(output.candidateValue)
        : 'n/a';
    const decision = accepted ? 'accepted' : 'rejected';
    if (metric && inc !== undefined) {
      return `${decision} · ${metric} ${inc} -> ${cand}`;
    }
    return decision;
  }
  if (contractId === 'contract.selector-artifacts') {
    if (typeof output.candidateRef === 'string') {
      return `selected ${shortRef(output.candidateRef)}`;
    }
    return undefined;
  }
  if (
    contractId === 'contract.proposer' ||
    contractId === 'contract.proposer-iterative' ||
    contractId === 'contract.proposer-operator' ||
    contractId === 'contract.proposer-grid'
  ) {
    if (output.status === 'no-change') return 'no changes';
    if (output.status === 'batch' && Array.isArray(output.candidates)) {
      return `${output.candidates.length} candidates`;
    }
    if (typeof output.candidateRef === 'string') {
      return `candidate ${shortRef(output.candidateRef)}`;
    }
    if (Array.isArray(output.candidates)) {
      return `${output.candidates.length} candidates`;
    }
    return undefined;
  }
  if (contractId === 'contract.memory') {
    if (output.status === 'updated') return 'updated';
    if (output.status === 'no-change') return 'no changes';
    if (output.status === 'failed') {
      return typeof output.reason === 'string' && output.reason
        ? `skipped (${output.reason})`
        : 'skipped';
    }
    return undefined;
  }
  if (contractId === 'contract.reflection') {
    if (output.status === 'proposed') return 'revision proposed';
    if (output.status === 'no-change') return 'no changes';
    return undefined;
  }
  if (contractId === 'contract.application') {
    const action =
      input && typeof input === 'object' && !Array.isArray(input)
        ? input.action
        : undefined;
    if (
      action === 'initialize' &&
      typeof output.initialCandidateRef === 'string'
    ) {
      return `candidate ${shortRef(output.initialCandidateRef)}`;
    }
    if (action === 'commit' && typeof output.candidateRef === 'string') {
      return `candidate ${shortRef(output.candidateRef)}`;
    }
    return undefined;
  }
  if (measurementSummary) return measurementSummary;
  if (typeof output.measurementRef === 'string') {
    return shortRef(output.measurementRef);
  }
  return undefined;
}

export function reusedCallsSummary(
  retryCalls: ReadonlyMap<string, JsonObject> | undefined,
): ReusedCallSummary[] {
  if (!retryCalls) return [];
  const entries: {
    summary: ReusedCallSummary;
    startedAt: number;
  }[] = [];
  for (const [key, call] of retryCalls) {
    if (key.startsWith('agent/')) continue;
    if (call.parentCallId !== 'root') continue;
    if (call.status !== 'succeeded') continue;
    if (typeof call.bindingId !== 'string' || typeof call.path !== 'string')
      continue;
    const startedMs =
      typeof call.startedAt === 'string' ? Date.parse(call.startedAt) : NaN;
    const finishedMs =
      typeof call.finishedAt === 'string' ? Date.parse(call.finishedAt) : NaN;
    const durationMs =
      Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? Math.max(0, finishedMs - startedMs)
        : undefined;
    entries.push({
      startedAt: Number.isFinite(startedMs) ? startedMs : 0,
      summary: {
        bindingId: call.bindingId,
        path: call.path,
        ...(typeof call.contractId === 'string'
          ? { contractId: call.contractId }
          : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    });
  }
  entries.sort((a, b) => a.startedAt - b.startedAt);
  return entries.map((entry) => entry.summary);
}

export function finishedRunProgress(
  experimentId: string,
  status: TerminalStatus,
  record: JsonObject,
  reused = false,
): RunFinishedProgress {
  const partial =
    record.output === undefined && record.partialOutput !== undefined;
  const output = partial ? record.partialOutput : record.output;
  const selected =
    output && typeof output === 'object' && !Array.isArray(output)
      ? output
      : {};
  const usage = record.usage;
  const counters =
    usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  const stopReason = record.stopReason ?? selected.stopReason;
  return {
    kind: 'experiment-finished',
    experimentId,
    status,
    reused,
    usage: Object.fromEntries(
      Object.entries(counters).flatMap(([name, value]) =>
        typeof value === 'number' ? [[name, value] as const] : [],
      ),
    ),
    candidateRef:
      typeof selected.candidateRef === 'string'
        ? selected.candidateRef
        : undefined,
    measurementRef:
      typeof selected.measurementRef === 'string'
        ? selected.measurementRef
        : undefined,
    partial,
    stopReason: typeof stopReason === 'string' ? stopReason : undefined,
    budgetMetric:
      typeof record.budgetMetric === 'string' ? record.budgetMetric : undefined,
  };
}
