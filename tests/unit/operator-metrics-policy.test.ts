import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { partialPolicyOutput } from '../../src/runtime/policy/executor.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { object, string } from '../../src/shared/json.js';

async function run(
  options: {
    values?: Array<number | null>;
    maxRounds?: number;
    maxRejectedProfiles?: number;
    maxNoImprovement?: number;
    maxConsecutiveNoChange?: number;
    noChangeRounds?: number[];
    noHypothesisRound?: number;
    profileFailure?: number;
    infrastructureFailure?: boolean;
    invalidFinal?: boolean;
  } = {},
) {
  const registry = new Registry();
  await registerBuiltins(registry);
  const policy = await Policy.load(
    resolve('src/policies/operator-search/policy.yaml'),
    registry,
  );
  const calls: Array<{ binding: string; input: JsonObject }> = [];
  const measurements = new Map<string, { candidate: string; value: number }>();
  let evaluation = 0,
    profiles = 0,
    modelRound = 0;
  let checkpoint: JsonObject | undefined;
  const invoke = async (
    binding: string,
    raw: JsonValue,
    path: string,
  ): Promise<JsonValue> => {
    const input = object(raw);
    calls.push({ binding, input: structuredClone(input) });
    if (binding === 'evaluator') {
      if (input.action === 'profile') {
        profiles++;
        if (options.infrastructureFailure)
          throw new Error('profile cleanup unconfirmed');
        return {
          action: 'profile',
          measurementRef: `p${profiles}`,
          collectionStatus:
            profiles === options.profileFailure ? 'unavailable' : 'completed',
        };
      }
      const candidate = string(input.candidateRef);
      const round = Number(candidate.replace(/^c/, ''));
      const value =
        options.invalidFinal && path === 'steps/evaluate_final'
          ? 0
          : candidate === 'baseline'
            ? 10
            : (options.values?.[round - 1] ??
              (candidate.startsWith('bad') ? 0 : 10));
      const ref = `m${++evaluation}`;
      measurements.set(ref, { candidate, value });
      return { action: 'evaluate', measurementRef: ref };
    }
    if (binding === 'selector') {
      const incumbent = measurements.get(
        string(input.incumbentMeasurementRef),
      )!;
      const candidate = measurements.get(
        string(input.candidateMeasurementRef),
      )!;
      const accepted =
        candidate.value > 0 &&
        (incumbent.value - candidate.value) / incumbent.value > 0.02;
      return {
        accepted,
        candidateFeasible: candidate.value > 0,
        selectedCandidateRef: accepted
          ? candidate.candidate
          : incumbent.candidate,
        reason: 'test measurement decision',
        decisionRef: `d${evaluation}`,
        measurementRef: string(input.candidateMeasurementRef),
        metric: 'latencyMeanMs',
        incumbentValue: incumbent.value,
        candidateValue: candidate.value > 0 ? candidate.value : null,
        selectedValue: accepted ? candidate.value : incumbent.value,
      };
    }
    if (binding === 'summarizer')
      return {
        action: 'summarize',
        historyRef: `h${input.round ?? input.attempt}`,
        summaryRef: `s${input.round ?? input.attempt}`,
      };
    if (input.phase === 'static')
      return {
        action: 'propose',
        status: 'no-change',
        candidateRef: 'baseline',
        diffRef: null,
        rationale: 'no static issues',
        analysisRef: 'static-analysis',
        reasonCode: 'no-static-issues',
      };
    if (input.action === 'repair')
      return {
        action: 'repair',
        status: 'created',
        candidateRef: `bad${input.repairIndex}`,
        diffRef: 'diff',
        rationale: 'repair',
        analysisRef: 'metrics-analysis',
        reasonCode: 'created',
      };
    modelRound++;
    if (
      options.noChangeRounds?.includes(modelRound) ||
      options.noHypothesisRound === modelRound
    )
      return {
        action: 'propose',
        status: 'no-change',
        candidateRef: string(input.parentCandidateRef),
        diffRef: null,
        rationale: 'No new testable hypothesis',
        analysisRef: 'metrics-analysis',
        reasonCode:
          options.noHypothesisRound === modelRound
            ? 'no-new-hypothesis'
            : 'no-supported-change',
      };
    if (options.values?.[modelRound - 1] === null)
      return {
        action: 'propose',
        status: 'failed',
        candidateRef: string(input.parentCandidateRef),
        diffRef: null,
        rationale: 'invalid model output',
        analysisRef: 'metrics-analysis',
        reasonCode: 'invalid-model-output',
        errorRef: 'error',
      };
    return {
      action: 'propose',
      status: 'created',
      candidateRef: `c${modelRound}`,
      diffRef: 'diff',
      rationale: 'metric proposal',
      analysisRef: 'metrics-analysis',
      reasonCode: 'created',
    };
  };
  const execution = {
    application: { initialCandidate: 'baseline' },
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    invoke,
    checkpoint: async (value: JsonObject) => {
      checkpoint = structuredClone(value);
    },
  };
  const config = {
    goal: 'metrics test',
    caseIds: ['fixed'],
    maxAttempts: 3,
    repairLimit: 3,
    metricsEnabled: true,
    maxRounds: options.maxRounds ?? 10,
    maxNoImprovement: options.maxNoImprovement ?? 5,
    ...(options.maxRejectedProfiles === undefined
      ? {}
      : { maxRejectedProfiles: options.maxRejectedProfiles }),
    ...(options.maxConsecutiveNoChange === undefined
      ? {}
      : { maxConsecutiveNoChange: options.maxConsecutiveNoChange }),
  };
  try {
    const output = object(
      await policy.execute({ ...execution, input: {}, config }),
    );
    const count = calls.length;
    const resumed = await policy.execute({
      ...execution,
      input: {},
      config,
      restore: checkpoint,
    });
    assert.deepEqual(resumed, output);
    assert.equal(calls.length, count);
    function partialAfter(path: string) {
      assert.ok(checkpoint);
      const entries = Object.entries(object(checkpoint.journal));
      const end = entries.findIndex(([key]) => key === path);
      assert.notEqual(end, -1, path);
      return partialPolicyOutput(
        policy,
        { application: execution.application, config },
        {
          ...checkpoint,
          journal: Object.fromEntries(entries.slice(0, end + 1)),
        },
      );
    }
    return { output, calls, partialAfter };
  } finally {
    await registry.dispose();
  }
}

test('no new metric hypothesis records its summary, stops search and still assesses the incumbent', async () => {
  const { output, calls } = await run({ noHypothesisRound: 1 });
  assert.equal(output.stopReason, 'no-new-hypothesis');
  assert.equal((output.metricsRounds as JsonValue[]).length, 1);
  assert.equal(calls.filter((c) => c.binding === 'summarizer').length, 1);
  assert.equal(calls.filter((c) => c.input.action === 'evaluate').length, 2);
  assert.equal(output.finalValidity, 'valid');
});

test('three consecutive empty metric proposals stop without inventing candidate measurements', async () => {
  const { output, calls } = await run({ noChangeRounds: [1, 2, 3, 4] });
  assert.equal(output.stopReason, 'consecutive-no-change');
  assert.equal(output.consecutiveNoChangeCount, 3);
  assert.equal(output.noImprovementCount, 0);
  assert.equal((output.metricsRounds as JsonValue[]).length, 3);
  assert.equal(calls.filter((c) => c.input.action === 'evaluate').length, 2);
});

test('a measured candidate resets consecutive empty proposals even when it is not promoted', async () => {
  const { output } = await run({ noChangeRounds: [1, 2, 4, 5, 6] });
  assert.equal(output.stopReason, 'consecutive-no-change');
  assert.equal(output.consecutiveNoChangeCount, 3);
  assert.equal(output.noImprovementCount, 1);
  assert.equal((output.metricsRounds as JsonValue[]).length, 6);
});

test('the consecutive empty proposal limit is configurable', async () => {
  const { output } = await run({
    noChangeRounds: [1, 2, 3],
    maxConsecutiveNoChange: 2,
  });
  assert.equal(output.stopReason, 'consecutive-no-change');
  assert.equal((output.metricsRounds as JsonValue[]).length, 2);
});

test('a failed proposal breaks a consecutive empty streak without claiming an evaluation', async () => {
  const { output } = await run({
    values: [10, null, 10, 10],
    noChangeRounds: [1, 3, 4],
    maxConsecutiveNoChange: 2,
  });
  assert.equal(output.stopReason, 'consecutive-no-change');
  assert.equal((output.metricsRounds as JsonValue[]).length, 4);
  assert.equal(output.noImprovementCount, 0);
});

test('metrics Greedy continues after promotion, reuses unchanged diagnostics, and supplies current best and history', async () => {
  const { output, calls } = await run({ values: [8, 9, 9], maxRounds: 3 });
  assert.equal(output.bestCandidateRef, 'c1');
  assert.equal(output.stopReason, 'max-rounds');
  const proposals = calls.filter(
    (c) =>
      c.binding === 'proposer' &&
      c.input.action === 'propose' &&
      c.input.phase === 'metrics',
  );
  assert.deepEqual(
    proposals.map((c) => [
      c.input.parentCandidateRef,
      c.input.diagnosticMeasurementRef,
      c.input.historyRef,
    ]),
    [
      ['baseline', 'p1', null],
      ['c1', 'p2', 'h1'],
      ['c1', 'p2', 'h2'],
    ],
  );
  assert.equal(calls.filter((c) => c.input.action === 'profile').length, 2);
  assert.equal((output.metricsRounds as JsonValue[]).length, 3);
  assert.equal(output.finalValidity, 'valid');
  assert.equal(
    calls.filter(
      (c) => c.input.action === 'propose' && c.input.phase === 'static',
    ).length,
    1,
  );
  assert.equal(
    object((output.metricsRounds as JsonObject[])[0]).diagnosticMeasurementRef,
    'p1',
  );
  assert.equal(
    object((output.metricsRounds as JsonObject[])[0])
      .candidateDiagnosticMeasurementRef,
    'p2',
  );
});

test('invalid proposals consume rounds without incrementing or resetting the no-gain count', async () => {
  const { output } = await run({ values: [10, null, 10, 10, 10, 10] });
  assert.equal(output.stopReason, 'no-improvement');
  assert.equal((output.metricsRounds as JsonValue[]).length, 6);
});

test('configured metrics search completes eleven rounds and restores its recorded output', async () => {
  const { output } = await run({ maxRounds: 11, maxNoImprovement: 11 });
  assert.equal(output.stopReason, 'no-improvement');
  assert.equal((output.metricsRounds as JsonValue[]).length, 11);
  assert.equal(output.noImprovementCount, 11);
});

test('failed verification exhausts three repairs and proceeds to another round', async () => {
  const { output, calls } = await run({ values: [0, 10], maxRounds: 2 });
  assert.equal(calls.filter((c) => c.input.action === 'repair').length, 3);
  const summaries = calls.filter((call) => call.binding === 'summarizer');
  assert.deepEqual(
    summaries.map(({ input }) =>
      (input.actions as JsonObject[]).map(({ action, candidateRef }) => [
        action,
        candidateRef,
      ]),
    ),
    [
      [
        ['propose', 'c1'],
        ['repair', 'bad1'],
        ['repair', 'bad2'],
        ['repair', 'bad3'],
      ],
      [['propose', 'c2']],
    ],
  );
  assert.equal((output.metricsRounds as JsonValue[]).length, 2);
  assert.equal(
    object((output.metricsRounds as JsonObject[])[0]).outcome,
    'verification-failed',
  );
});

test('unavailable winner diagnostics preserve the promoted source and finish with independent retest', async () => {
  const { output, calls } = await run({ values: [8], profileFailure: 2 });
  assert.equal(output.bestCandidateRef, 'c1');
  assert.equal(output.stopReason, 'profiling-unavailable');
  assert.equal(
    calls.filter((c) => c.input.action === 'evaluate').at(-1)?.input
      .candidateRef,
    'c1',
  );
});

test('unknown profiling cleanup stops before any final device call', async () => {
  await assert.rejects(
    run({ infrastructureFailure: true }),
    /cleanup unconfirmed/,
  );
});

test('unavailable entry diagnostics finish without generating metric candidates', async () => {
  const { output, calls } = await run({ profileFailure: 1 });
  assert.equal(output.stopReason, 'profiling-unavailable');
  assert.equal((output.metricsRounds as JsonValue[]).length, 0);
  assert.equal(
    calls.filter((c) => c.binding === 'proposer' && c.input.phase === 'metrics')
      .length,
    0,
  );
  assert.equal(calls.filter((c) => c.input.action === 'evaluate').length, 2);
});

test('near misses get bounded diagnostics while the next round keeps its incumbent', async () => {
  const { output, calls } = await run({
    values: [10.1, 10.2, 10.6, 9.85, 9.9],
    maxRounds: 5,
    maxNoImprovement: 6,
  });
  const profiles = calls.filter(({ input }) => input.action === 'profile');
  assert.deepEqual(
    profiles.map(({ input }) => input.candidateRef),
    ['baseline', 'c1', 'c4'],
  );
  const summaries = calls.filter(
    ({ binding, input }) =>
      binding === 'summarizer' && input.phase === 'metrics',
  );
  assert.deepEqual(
    summaries.map(({ input }) => input.candidateDiagnosticMeasurementRef),
    ['p2', null, null, 'p3', null],
  );
  assert.equal(output.bestCandidateRef, 'baseline');
  const next = calls.find(
    ({ input }) => input.action === 'propose' && input.round === 2,
  );
  assert.equal(next?.input.diagnosticMeasurementRef, 'p1');
  assert.equal(next?.input.historyRef, 'h1');

  const control = await run({
    values: [9.85],
    maxRounds: 2,
    maxRejectedProfiles: 0,
  });
  assert.equal(
    control.calls.filter(({ input }) => input.action === 'profile').length,
    1,
  );
});

test('operator checkpoint keeps the selected fifth round after a slower sixth and distinguishes the final verdict', async () => {
  const { partialAfter } = await run({
    values: [10, 10, 10, 10, 8, 9, 9],
    maxRounds: 7,
    maxNoImprovement: 10,
    invalidFinal: true,
  });
  assert.equal(partialAfter('steps/evaluate_baseline'), undefined);
  const selected = {
    bestCandidateRef: 'c5',
    bestMeasurementRef: 'm6',
    finalMeasurementRef: null,
    finalDecisionRef: null,
    finalValidity: null,
  };
  assert.deepEqual(
    partialAfter('steps/run_metrics/then/metrics_loop/iteration-6/begin_round'),
    selected,
  );
  const measured = { ...selected, finalMeasurementRef: 'm9' };
  assert.deepEqual(partialAfter('steps/evaluate_final'), measured);
  assert.deepEqual(partialAfter('steps/check_final'), {
    ...measured,
    finalDecisionRef: 'd9',
    finalValidity: 'invalid',
  });
});
