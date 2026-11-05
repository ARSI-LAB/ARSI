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
import { readPolicy } from '../../src/runtime/compiler/index.js';
import { executePolicy } from '../../src/runtime/policy/index.js';
import { object, string } from '../../src/shared/json.js';

async function run(
  options: {
    values?: Array<number | null>;
    maxRounds?: number;
    profileFailure?: number;
    infrastructureFailure?: boolean;
  } = {},
) {
  const registry = new Registry();
  await registerBuiltins(registry);
  const policy = await readPolicy(
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
        candidate === 'baseline'
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
    if (input.action === 'summarize')
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
    maxNoImprovement: 5,
  };
  try {
    const output = object(await executePolicy(policy, {}, config, execution));
    const count = calls.length;
    const resumed = await executePolicy(policy, {}, config, {
      ...execution,
      restore: checkpoint,
    });
    assert.deepEqual(resumed, output);
    assert.equal(calls.length, count);
    return { output, calls };
  } finally {
    await registry.dispose();
  }
}

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

test('failed verification exhausts three repairs and proceeds to another round', async () => {
  const { output, calls } = await run({ values: [0, 10], maxRounds: 2 });
  assert.equal(calls.filter((c) => c.input.action === 'repair').length, 3);
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
