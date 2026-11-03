import { readAllObservationPages } from '../../web/api/read-all-pages.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreGroups,
  scorePoints,
  callDurations,
} from '../../web/features/experiments/charts/metric-data.js';
import {
  parseCalls,
  type MeasurementSummary,
  type MetricRecord,
  type CallSummary,
} from '../../web/api/observation-client.js';

function measurement(
  ref: string,
  candidateRef = 'candidate-a',
): MeasurementSummary {
  return {
    ref,
    candidateRef,
    callId: 'call-a',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: 'dataset-a',
    startedAt: '2026-10-29T00:00:00Z',
    finishedAt: '2026-10-29T00:00:02Z',
    metrics: [
      {
        name: 'score',
        definitionRef: 'definition-a',
        unit: 'ratio',
        description: 'Score',
        status: 'available',
        reason: null,
        values: { value: 0 },
      },
    ],
  };
}
function call(callId: string): CallSummary {
  return {
    callId,
    parentCallId: null,
    bindingId: 'custom',
    pluginId: 'custom.plugin',
    path: null,
    status: 'succeeded',
    startedAt: '2026-10-29T00:00:00Z',
    finishedAt: '2026-10-29T00:00:02Z',
    error: null,
  };
}
test('score groups isolate definitions, conditions, units and coverage without inferring direction', () => {
  const baseline = measurement('m1'),
    condition = measurement('m2'),
    definition = measurement('m3'),
    partial = measurement('m4'),
    unknown = measurement('m5'),
    unit = measurement('m6');
  condition.comparisonKey = 'dataset-b';
  definition.metrics[0]!.definitionRef = 'definition-b';
  partial.coverage = 'partial';
  unknown.comparisonKey = null;
  unit.metrics[0]!.unit = 'seconds';
  const rows = [baseline, condition, definition, partial, unknown, unit];
  const groups = scoreGroups(rows);
  assert.equal(groups.length, 6);
  for (const group of groups)
    assert.equal(scorePoints(rows, group, 'value').length, 1);
  assert.equal(
    groups.find((group) => group.comparisonKey === null)?.comparable,
    false,
  );
  assert.equal(
    groups.find((group) => group.coverage === 'partial')?.comparable,
    false,
  );
});
test('score points retain zero, repeats, unavailable gaps and separate distribution statistics', () => {
  const first = measurement('m1'),
    repeated = measurement('m2'),
    gap = measurement('m3'),
    failed = measurement('m4');
  repeated.metrics[0]!.values.value = 0.8;
  gap.metrics[0]!.status = 'unavailable';
  gap.metrics[0]!.values = {};
  gap.metrics[0]!.reason = 'No score';
  failed.status = 'failed';
  failed.metrics[0]!.values.value = 1;
  const rows = [failed, gap, repeated, first];
  const points = scorePoints(rows, scoreGroups(rows)[0]!, 'value');
  assert.deepEqual(
    points.map((point) => point.value),
    [0, 0.8, null, null],
  );
  assert.deepEqual(
    points.map((point) => point.candidateLabel),
    ['C-a', 'C-a', 'C-a', 'C-a'],
  );
  assert.deepEqual(
    points.map((point) => point.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(points[2]?.reason, 'No score');
  const absent = measurement('m5');
  absent.metrics = [];
  const withGap = [...rows, absent];
  assert.equal(
    scorePoints(withGap, scoreGroups(withGap)[0]!, 'value')[4]?.value,
    null,
  );
  assert.equal(
    scorePoints(withGap, scoreGroups(withGap)[0]!, 'value')[4]?.reason,
    'Metric not recorded',
  );
  const distribution = measurement('m5');
  distribution.metrics[0]!.values = {
    count: 10,
    mean: 0.5,
    p95: 0.9,
    p99: null,
  };
  const group = scoreGroups([distribution])[0]!;
  assert.deepEqual(group.statistics, ['mean', 'p95', 'p99']);
  assert.equal(scorePoints([distribution], group, 'p95')[0]?.value, 0.9);
  assert.equal(scorePoints([distribution], group, 'p99')[0]?.value, null);
});
test('durations preserve zero and failure durations but exclude unfinished or invalid timestamps', () => {
  const zero = call('c1'),
    failed = call('c2'),
    running = call('c3'),
    reversed = call('c4'),
    invalid = call('c5');
  zero.finishedAt = zero.startedAt;
  failed.status = 'failed';
  running.status = 'running';
  running.finishedAt = null;
  reversed.finishedAt = '2026-10-28T00:00:00Z';
  invalid.startedAt = 'invalid';
  assert.deepEqual(
    callDurations([zero, failed, running, reversed, invalid]).map(
      (row) => row.seconds,
    ),
    [0, 2, null, null, null],
  );
});
test('charts fetch every page, reject partial or changing collections and propagate abort', async (t) => {
  const requested: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      const url = String(input);
      requested.push(url);
      const offset = Number(
        new URL(url, 'http://localhost').searchParams.get('offset'),
      );
      const items = Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) =>
        call(`call-${offset + index}`),
      );
      return new Response(
        JSON.stringify({
          items,
          total: 101,
          nextOffset: offset === 0 ? 100 : null,
        }),
      );
    },
  );
  const collection = await readAllObservationPages('/run/calls', parseCalls);
  assert.equal(collection.items.length, 101);
  assert.equal(collection.nextOffset, null);
  assert.equal(requested.length, 2);
  assert.match(requested[1]!, /offset=100/);
  t.mock.restoreAll();
  for (const payload of [
    { items: [], total: 5001, nextOffset: null },
    { items: [], total: 2, nextOffset: null },
    { items: [call('a')], total: 2, nextOffset: 0 },
  ]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify(payload)),
    );
    await assert.rejects(readAllObservationPages('/run/calls', parseCalls));
    t.mock.restoreAll();
  }
  let count = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify(
          ++count === 1
            ? { items: [call('a')], total: 2, nextOffset: 1 }
            : { items: [call('b')], total: 3, nextOffset: null },
        ),
      ),
  );
  await assert.rejects(
    readAllObservationPages('/run/calls', parseCalls),
    /Records changed/,
  );
  const controller = new AbortController();
  controller.abort(new Error('Navigated away'));
  await assert.rejects(
    readAllObservationPages('/run/calls', parseCalls, controller.signal),
    /Navigated away/,
  );
});

test('item charts isolate subjects and parameters, retaining repeated observations without aggregate mixing', () => {
  const item: MetricRecord = {
    ...measurement('m1'),
    item: {
      id: 'i1',
      subjectKind: 'point',
      subjectId: 'A',
      parametersRef: 'params-a',
    },
  };
  const repeat: MetricRecord = { ...item, ref: 'm2' };
  const other: MetricRecord = {
    ...item,
    item: { ...item.item!, id: 'i2', subjectId: 'B' },
  };
  const parameters: MetricRecord = {
    ...item,
    item: { ...item.item!, id: 'i3', parametersRef: 'params-b' },
  };
  const rows = [measurement('m0'), item, repeat, other, parameters];
  const groups = scoreGroups(rows);
  assert.equal(groups.length, 4);
  const points = scorePoints(
    rows,
    groups.find((group) => group.subject === 'point: A')!,
    'value',
  );
  assert.equal(points.length, 2);
  assert.equal(new Set(points.map((point) => point.observationKey)).size, 2);
  assert.deepEqual(
    points.map((point) => point.value),
    [0, 0],
  );
});

test('aggregate and task views share experiment-wide evaluation numbers and fixed candidate identities', () => {
  const first: MetricRecord = {
    ...measurement('m1', 'candidate-a'),
    item: null,
  };
  const task: MetricRecord = {
    ...measurement('m1', 'candidate-a'),
    item: {
      id: 'task-1',
      subjectKind: 'task',
      subjectId: 'task-1',
      parametersRef: null,
    },
  };
  const second: MetricRecord = {
    ...measurement('m2', 'candidate-b'),
    item: null,
  };
  second.startedAt = '2026-10-29T00:01:00Z';
  const rows = [first, task, second];
  const aggregate = scoreGroups(rows).find(
    (group) => group.scopeKey === 'aggregate',
  )!;
  const unscored = measurement('m0');
  unscored.metrics = [];
  const evaluations = [unscored, first, second];
  const points = scorePoints(rows, aggregate, 'value', evaluations);
  assert.deepEqual(
    points.map((point) => point.sequence),
    [2, 3],
  );
  assert.deepEqual(
    points.map((point) => point.candidateLabel),
    ['C-a', 'C-b'],
  );
  assert.equal(
    points.filter((point) => point.candidateRef === 'candidate-b')[0]
      ?.candidateLabel,
    'C-b',
  );
  const taskGroup = scoreGroups(rows).find(
    (group) => group.scopeKey !== 'aggregate',
  )!;
  assert.equal(
    scorePoints(rows, taskGroup, 'value', evaluations)[0]!.sequence,
    2,
  );
  assert.equal(points[1]!.callId, second.callId);
  assert.throws(
    () => scorePoints(rows, aggregate, 'value', []),
    /metadata is incomplete/,
  );
});
