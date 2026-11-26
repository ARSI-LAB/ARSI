import { setTimeout as delay } from 'node:timers/promises';
import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { metricSelectorContract } from '../../../contracts/plugin-types/selector-metrics.js';
import type { Manager } from '../../../runtime/manager/index.js';
import {
  checkpointedCalls,
  readRetryCalls,
} from '../../../runtime/manager/retry.js';
import { PolicyCheckpoints } from '../../../runtime/policy/checkpoint.js';
import {
  callLabel,
  formatDuration,
  selectionLogDetails,
  type SelectionLogDetails,
} from '../../../shared/call-log.js';
import { cliLogger, formatSelection } from '../logging/index.js';

function record(value?: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function scalarMetric(
  metrics: JsonValue | undefined,
  name: string,
): number | undefined {
  const entry = record(record(metrics)?.[name]);
  const value = record(entry?.value);
  if (
    entry?.status === 'available' &&
    value?.kind === 'scalar' &&
    typeof value.value === 'number'
  )
    return value.value;
}

function byStart(a: JsonObject, b: JsonObject): number {
  return (
    String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) ||
    String(a.path ?? '').localeCompare(String(b.path ?? ''))
  );
}

function roundFor(path: string): { key: string; label: string } | undefined {
  const round = /^steps\/.+?\/iteration-(\d+)\//.exec(path);
  if (!round) return;
  const key = round[0];
  const stage = key.startsWith('steps/static_search/')
    ? 'Static · '
    : key.startsWith('steps/run_metrics/then/metrics_loop/')
      ? 'Metrics · '
      : '';
  return { key, label: stage + 'Round ' + (Number(round[1]) + 1) };
}

function selectionFor(call: JsonObject): SelectionLogDetails | undefined {
  if (call.contractId === metricSelectorContract.id)
    return selectionLogDetails(call.output);
}

async function readMeasurement(
  manager: Manager,
  experimentId: string,
  ref?: JsonValue,
): Promise<JsonObject | undefined> {
  if (typeof ref !== 'string') return;
  const measurement = await manager.facts
    .read('measurements', ref)
    .catch(() => undefined);
  if (measurement?.experimentId === experimentId) return measurement;
}

function reportReusedCalls(
  receipts: JsonObject[],
  onMeasurement: (experimentId: string, callId: string, ref: string) => void,
): void {
  for (const call of receipts.sort(byStart)) {
    const { callId, bindingId, path, experimentId } = call;
    if (
      typeof callId !== 'string' ||
      typeof bindingId !== 'string' ||
      typeof path !== 'string' ||
      typeof experimentId !== 'string'
    )
      continue;

    const step = path.split('/').at(-1);
    const round = roundFor(path);
    const phase =
      step === 'baseline' || path === 'steps/evaluate_baseline'
        ? 'Baseline'
        : path === 'steps/evaluate_final'
          ? 'Retest'
          : step === 'test'
            ? 'Test'
            : undefined;
    const title = callLabel(
      bindingId,
      phase ? undefined : path,
      record(call.input)?.action,
    );
    const group = phase ?? round?.label;
    const label = group ? `${group} · ${title}` : title;
    const elapsed =
      Date.parse(String(call.finishedAt)) - Date.parse(String(call.startedAt));
    const duration = elapsed >= 0 ? ` ${formatDuration(elapsed)}` : '';
    const output = record(call.output);
    const candidateRef =
      output?.candidateRef ??
      output?.initialCandidateRef ??
      output?.selectedCandidateRef;
    const selection = selectionFor(call);
    const detail =
      call.status === 'failed'
        ? ' · previously failed'
        : selection
          ? ` · ${formatSelection(selection)}`
          : typeof candidateRef === 'string'
            ? ` · ${candidateRef}`
            : '';
    cliLogger.info('{label}{duration}{detail}', {
      stage: 'Reused',
      terminalOnly: true,
      experimentId,
      callId,
      label,
      duration,
      detail,
      candidateRef,
    });

    if (typeof output?.measurementRef === 'string')
      onMeasurement(experimentId, callId, output.measurementRef);
  }
}

async function reportReusedScores(
  manager: Manager,
  experimentId: string,
  callId: string,
  ref: string,
  isOpen: () => boolean,
): Promise<void> {
  const measurement = await readMeasurement(manager, experimentId, ref);
  if (
    !isOpen() ||
    measurement?.callId !== callId ||
    typeof measurement.itemsRef !== 'string'
  )
    return;
  const artifact = await manager.artifacts.readJson(measurement.itemsRef);
  const items = record(artifact)?.items;
  if (!isOpen() || !Array.isArray(items)) return;
  for (const raw of items) {
    const item = record(raw);
    const id = record(item?.subject)?.id ?? item?.id;
    if (typeof id !== 'string' || typeof item?.status !== 'string') continue;
    const score =
      scalarMetric(item.metrics, 'score') ??
      scalarMetric(item.metrics, 'reward');
    cliLogger.info('{itemId} · {status}{score}', {
      stage: 'Progress',
      terminalOnly: true,
      experimentId,
      parentCallId: callId,
      itemId: id,
      status: item.status,
      score: score === undefined ? '' : ' · score=' + score.toFixed(4),
    });
  }
}

// Allow pending reads to settle once execution has finished.
const replayDrainMs = 750;

export function createResumeReport(manager: Manager): {
  onReusedCalls(receipts: JsonObject[]): void;
  restoreCompleted(experiment: JsonObject): void;
  finish(): Promise<void>;
} {
  let open = true;
  let notified = false;
  let rows = Promise.resolve();
  let scores = Promise.resolve();
  const render = (receipts: JsonObject[]): void => {
    if (!open) return;
    reportReusedCalls(receipts, (experimentId, callId, ref) => {
      scores = scores
        .then(() => {
          if (open)
            return reportReusedScores(
              manager,
              experimentId,
              callId,
              ref,
              () => open,
            );
        })
        .catch(() => {});
    });
  };
  return {
    onReusedCalls(receipts) {
      notified = true;
      rows = rows.then(() => render(receipts)).catch(() => {});
    },
    restoreCompleted(experiment) {
      // An already successful experiment returns before visiting any Policy steps.
      const id = experiment.id;
      if (
        notified ||
        experiment.status !== 'succeeded' ||
        typeof id !== 'string'
      )
        return;
      rows = rows
        .then(async () => {
          if (!open) return;
          const [calls, checkpoint] = await Promise.all([
            readRetryCalls(manager.facts, id),
            new PolicyCheckpoints(manager.facts, id).restore(),
          ]);
          render(
            checkpointedCalls(
              calls,
              checkpoint,
              typeof record(experiment.application)?.initialCandidateRef ===
                'string',
            ),
          );
        })
        .catch(() => {});
    },
    async finish() {
      const timer = new AbortController();
      try {
        await Promise.race([
          rows.then(() => scores),
          delay(replayDrainMs, undefined, { signal: timer.signal }),
        ]);
      } finally {
        open = false;
        timer.abort();
      }
    },
  };
}

interface SummaryRow {
  label: string;
  detail: string;
  candidateRef?: string;
}

function summarizeMeasurement(
  label: string,
  measurement: JsonObject,
  metric?: string,
): SummaryRow {
  const candidateRef =
    typeof measurement.candidateRef === 'string'
      ? measurement.candidateRef
      : undefined;
  const names = metric
    ? [metric]
    : [
        'successRate',
        'meanReward',
        'score',
        'reward',
        ...Object.keys(record(measurement.metrics) ?? {}),
      ];
  for (const name of names) {
    const value = scalarMetric(measurement.metrics, name);
    if (value !== undefined)
      return { label, candidateRef, detail: `${name} ${value.toFixed(4)}` };
  }
  return {
    label,
    candidateRef,
    detail: typeof measurement.status === 'string' ? measurement.status : '',
  };
}

export async function reportRunSummary(
  manager: Manager,
  experimentId: string,
  finished?: JsonObject,
): Promise<void> {
  const calls: JsonObject[] = [];
  for await (const call of manager.facts.scan?.('calls') ??
    (await manager.facts.list('calls'))) {
    if (
      call.experimentId === experimentId &&
      call.parentCallId === 'root' &&
      call.status === 'succeeded' &&
      typeof call.path === 'string' &&
      call.path.startsWith('steps/')
    )
      calls.push(call);
  }
  calls.sort(byStart);
  const rounds = new Map<
    string,
    {
      label: string;
      validation?: JsonValue;
      selection?: SelectionLogDetails;
      noChange?: boolean;
    }
  >();
  let baseline: JsonValue | undefined;
  let test: JsonValue | undefined;
  const metricsByMeasurement = new Map<string, string>();
  for (const call of calls) {
    if (typeof call.path !== 'string') continue;
    const step = call.path.split('/').at(-1);
    const output = record(call.output);
    const selection = selectionFor(call);
    if (selection)
      for (const ref of [
        output?.measurementRef,
        record(call.input)?.incumbentMeasurementRef,
        record(call.input)?.candidateMeasurementRef,
      ])
        if (typeof ref === 'string')
          metricsByMeasurement.set(ref, selection.metric);
    if (step === 'baseline' || call.path === 'steps/evaluate_baseline')
      baseline = output?.measurementRef;
    if (step === 'test') test = output?.measurementRef;
    const round = roundFor(call.path);
    if (!round) continue;
    const summary = rounds.get(round.key) ?? { label: round.label };
    if (step === 'validate') summary.validation = output?.measurementRef;
    if (selection) summary.selection = selection;
    if (step === 'propose' && output?.status === 'no-change')
      summary.noChange = true;
    rounds.set(round.key, summary);
  }

  const metricFor = (measurement: JsonObject): string | undefined =>
    typeof measurement.ref === 'string'
      ? metricsByMeasurement.get(measurement.ref)
      : undefined;
  const rows: SummaryRow[] = [];
  const baselineMeasurement = await readMeasurement(
    manager,
    experimentId,
    baseline,
  );
  if (baselineMeasurement)
    rows.push(
      summarizeMeasurement(
        'Baseline',
        baselineMeasurement,
        metricFor(baselineMeasurement),
      ),
    );
  for (const round of rounds.values()) {
    const { label } = round;
    if (round.selection)
      rows.push({ label, detail: formatSelection(round.selection) });
    else if (round.noChange) rows.push({ label, detail: 'no change' });
    else {
      const measurement = await readMeasurement(
        manager,
        experimentId,
        round.validation,
      );
      if (measurement) {
        const row = summarizeMeasurement(
          label,
          measurement,
          metricFor(measurement),
        );
        rows.push({ ...row, detail: `validation · ${row.detail}` });
      }
    }
  }
  const experiment =
    finished ?? (await manager.get(experimentId).catch(() => undefined));
  const output = record(
    experiment?.status === 'succeeded'
      ? experiment.output
      : experiment?.partialOutput,
  );
  const testMeasurement = await readMeasurement(
    manager,
    experimentId,
    output?.finalMeasurementRef ?? output?.testMeasurementRef ?? test,
  );
  if (testMeasurement)
    rows.push(
      summarizeMeasurement(
        typeof output?.finalMeasurementRef === 'string' ? 'Retest' : 'Test',
        testMeasurement,
        metricFor(testMeasurement),
      ),
    );
  const selected =
    output?.bestCandidateRef ??
    output?.candidateRef ??
    output?.selectedCandidateRef;
  if (typeof selected === 'string') {
    const measurement = await readMeasurement(
      manager,
      experimentId,
      output?.bestMeasurementRef ?? output?.measurementRef,
    );
    const detail =
      measurement?.candidateRef === selected
        ? summarizeMeasurement('Selected', measurement, metricFor(measurement))
            .detail
        : '';
    rows.push({ label: 'Selected', candidateRef: selected, detail });
  }
  if (!rows.length) return;
  cliLogger.info('', { stage: 'Summary', terminalOnly: true, experimentId });
  for (const { label, detail, candidateRef } of rows) {
    cliLogger.info('{line}', {
      stage: 'Summary',
      terminalOnly: true,
      experimentId,
      cargoDepth: 1,
      candidateRef,
      line: [label, candidateRef, detail].filter(Boolean).join(' · '),
    });
  }
}
