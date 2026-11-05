import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoundLabels,
  harnessStage,
  roundLabel,
} from '../../web/features/experiments/round-label-model.js';
import type {
  CallSummary,
  MeasurementSummary,
} from '../../src/contracts/observation.js';
test('round labels use creation provenance and evaluation paths independently', () => {
  const call = (
    callId: string,
    path: string,
    parentCallId: string | null = null,
  ): CallSummary => ({
    callId,
    path,
    parentCallId,
    bindingId: 'evaluation',
    pluginId: 'evaluator',
    status: 'succeeded',
    startedAt: null,
    finishedAt: null,
    error: null,
  });
  const measurement = (ref: string, callId: string): MeasurementSummary => ({
    ref,
    callId,
    candidateRef: 'old',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: null,
    startedAt: null,
    finishedAt: null,
    metrics: [],
  });
  const labels = buildRoundLabels(
    [
      { ref: 'base', parentRef: null, artifactRef: 'a' },
      {
        ref: 'old',
        parentRef: 'base',
        artifactRef: 'b',
        originPath: 'loop/0/propose',
      },
      {
        ref: 'other',
        parentRef: 'base',
        artifactRef: 'c',
        originPath: 'loop/0/propose',
      },
      { ref: 'unknown', parentRef: 'old', artifactRef: 'd' },
    ],
    [
      call('base-call', 'init/baseline'),
      call('later', 'loop/7/train'),
      call('child', 'opaque', 'later'),
      call('nested', 'steps/outer/iteration-1/inner/iteration-2/validate'),
      call('nested-child', 'opaque', 'nested'),
    ],
    [
      measurement('m0', 'base-call'),
      measurement('m8', 'child'),
      measurement('nested-measurement', 'nested-child'),
    ],
  );
  assert.equal(labels.candidate('base'), 'Baseline');
  assert.match(labels.candidate('old'), /^Round 1 · \d$/);
  assert.notEqual(labels.candidate('old'), labels.candidate('other'));
  assert.match(labels.candidate('unknown'), /^Candidate \d$/);
  assert.equal(labels.evaluation('m0'), 'Baseline evaluation');
  assert.equal(labels.evaluation('m8'), 'Round 8 · Training');
  assert.equal(
    labels.evaluation('nested-measurement'),
    'Round 2 / Round 3 · Validation',
  );
  assert.equal(roundLabel('call-x/loop/0/propose'), 'Round 1');
  assert.equal(roundLabel('opaque'), null);
});

test('round labels decode current and historical iterations without interpreting opaque paths', () => {
  for (const [path, expected] of [
    ['steps/rounds/iteration-0/propose', 'Round 1'],
    ['steps/search/iteration-7/train', 'Round 8'],
    ['steps/outer/iteration-1/inner/iteration-2/propose', 'Round 2 / Round 3'],
    ['loop/1/inner/loop/2/propose', 'Round 2 / Round 3'],
    ['loop/1/loop/2/propose', 'Round 2 / Round 3'],
    ['call-x/loop/0/propose', 'Round 1'],
    ['steps/search/iteration-0', 'Round 1'],
    ['steps/iteration-7', null],
    ['steps/iteration-7/iteration-0/propose', 'Round 1'],
    ['steps/outer/iteration-1/iteration-7', 'Round 2'],
    ['steps/check/then/iteration-7', null],
    ['steps/check/then/loop/iteration-2/propose', 'Round 3'],
    ['steps/items/key-a/iteration-7/iteration-2/propose', 'Round 3'],
    ['opaque/iteration-7', null],
    ['loop/0', 'Round 1'],
    ['opaque', null],
    ['steps/search/iteration--1/propose', null],
    ['steps/search/iteration-1x/propose', null],
    ['loop/-1/propose', null],
    ['loop/1x/propose', null],
    ['steps/search/iteration-9007199254740992/propose', null],
    ['loop/9007199254740992/propose', null],
    [undefined, null],
    [null, null],
  ] as const) {
    assert.equal(roundLabel(path), expected, String(path));
  }
});

test('Harness2 labels recognize the current policy branches and keep unrelated paths generic', () => {
  for (const [branch, step, variant] of [
    ['base', 'execute_base', 'Base'],
    ['invariant', 'propose_inv', 'Invariant'],
    ['invariant', 'execute_inv', 'Invariant'],
    ['domain', 'propose_dom', 'Domain'],
    ['domain', 'execute_dom', 'Domain'],
    ['compose', 'compose_candidate', 'Composed'],
    ['compose', 'execute_composed', 'Composed'],
  ] as const) {
    assert.deepEqual(
      harnessStage(`steps/search/iteration-2/${branch}/key-a/${step}`),
      { round: 'Round 3', variant },
    );
    assert.deepEqual(harnessStage(`loop/2/${branch}/key-a/${step}`), {
      round: 'Round 3',
      variant,
    });
  }
  assert.equal(
    harnessStage('steps/search/iteration-0/custom/key-a/execute_base'),
    null,
  );
  assert.equal(
    harnessStage('steps/search/iteration-0/base/key-a/unrelated'),
    null,
  );
});

test('Harness2 distinguishes task rounds, branch variants, repeated attempts and reused baselines', () => {
  const variants = ['base', 'invariant', 'domain', 'compose'];
  const steps = [
    'execute_base',
    'execute_inv',
    'execute_dom',
    'execute_composed',
  ];
  const calls: CallSummary[] = [0, 1].flatMap((round) =>
    variants.map((variant, index) => ({
      callId: `r${round}-${variant}`,
      parentCallId: null,
      path: `loop/${round}/${variant}/key-a/${steps[index]}`,
      bindingId: 'evaluator',
      pluginId: 'evaluator.agentbench',
      status: 'succeeded',
      startedAt: null,
      finishedAt: null,
      error: null,
    })),
  );
  const measurements: MeasurementSummary[] = calls.map((call, index) => ({
    ref: `m${index}`,
    callId: call.callId,
    candidateRef: index % 4 === 0 ? 'base' : `candidate-${index}`,
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: `task-${Math.floor(index / 4)}`,
    startedAt: `2026-11-03T0${index}:00:00Z`,
    finishedAt: null,
    metrics: [],
  }));
  calls.push({
    ...calls[1]!,
    callId: 'repeat',
    path: 'loop/0/invariant/key-b/execute_inv',
  });
  measurements.push({
    ...measurements[1]!,
    ref: 'repeat',
    callId: 'repeat',
    candidateRef: 'repeat',
  });
  const records = measurements.map((measurement, index) => ({
    ...measurement,
    item: {
      id: `item-${index}`,
      subjectKind: 'task',
      subjectId:
        index < 4 || index === 8 ? 'workbuddy/task-one' : 'workbuddy/task-two',
      parametersRef: null,
    },
  }));
  const labels = buildRoundLabels(
    [
      { ref: 'base', parentRef: null, artifactRef: 'a' },
      {
        ref: 'candidate-1',
        parentRef: 'base',
        artifactRef: 'b',
        originPath: 'loop/0/invariant/key-a/propose_inv',
      },
      {
        ref: 'candidate-2',
        parentRef: 'base',
        artifactRef: 'c',
        originPath: 'loop/0/domain/key-a/propose_dom',
      },
      {
        ref: 'candidate-3',
        parentRef: 'base',
        artifactRef: 'd',
        originPath: 'loop/0/compose/key-a/compose_candidate',
      },
    ],
    calls,
    measurements,
    records,
  );
  assert.equal(labels.isHarness, true);
  assert.equal(labels.candidate('base'), 'Baseline');
  assert.equal(labels.candidate('candidate-1'), 'Round 1 · Invariant');
  assert.equal(labels.candidate('candidate-2'), 'Round 1 · Domain');
  assert.equal(labels.candidate('candidate-3'), 'Round 1 · Composed');
  assert.equal(labels.evaluation('m0'), 'Round 1 · Base');
  assert.equal(labels.evaluation('m4'), 'Round 2 · Base');
  assert.equal(labels.evaluation('m1'), 'Round 1 · Invariant · 1');
  assert.equal(labels.evaluation('repeat'), 'Round 1 · Invariant · 2');
  assert.equal(labels.task('m0'), 'workbuddy/task-one');
  assert.equal(
    labels.evaluationGroup(['m0', 'm1', 'm2', 'm3']),
    'Round 1 · task-one',
  );
  assert.equal(labels.evaluationGroup(['m4', 'm5']), 'Round 2 · task-two');
  assert.equal(labels.evaluationGroup(['missing']), null);
  assert.equal(labels.harness('missing'), null);
  const ambiguous = buildRoundLabels([], calls, measurements, [
    ...records,
    {
      ...records[0]!,
      item: { ...records[0]!.item, subjectId: 'another-task' },
    },
  ]);
  assert.equal(ambiguous.task('m0'), null);
});
