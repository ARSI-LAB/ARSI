import test, { type TestContext } from 'node:test';
import { RuntimeContext } from '../../src/contracts/index.js';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { object, string } from '../../src/shared/json.js';

// One agent proposal per round, consumed in order. A feasible first proposal
// becomes the incumbent via self-comparison; later proposals must strictly
// improve p50, a gate-failing proposal is measured but never adopted, and a
// proposal that cannot be measured at all (evaluator status 'failed') is
// counted as a stale round without ever reaching the selector.
type Proposal = {
  p50: number;
  feasible: boolean;
  noChange?: boolean;
  evaluable?: boolean;
};

function stubOptions(
  state: {
    parents: string[];
    evaluated: string[];
    selected?: string[];
    memoryCalls?: JsonObject[];
  },
  sequence: Proposal[],
  checkpoint: { value: JsonObject },
  memory: 'updated' | 'no-change' = 'updated',
) {
  return {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    checkpoint: async (value: JsonObject) => {
      checkpoint.value = value;
    },
    invoke: async (name: string, raw: unknown): Promise<JsonObject> => {
      const input = object(raw);
      if (name === 'proposer') {
        const round = state.parents.length;
        const proposal = sequence[round];
        if (!proposal) throw new Error('unexpected extra proposal round');
        state.parents.push(string(input.parent));
        assert.equal(input.goal, 'Improve the kernel');
        assert.equal(
          input.memoryRef,
          null,
          'memory starts null within a single run (cross-run only via persistence)',
        );
        if (proposal.noChange)
          return {
            status: 'no-change',
            candidateRef: string(input.parent),
            diffRef: null,
            rationale: 'No further change proposed.',
          };
        return {
          status: 'created',
          candidateRef: `c${round + 1}`,
          diffRef: `d${round + 1}`,
          rationale: 'Proposal.',
        };
      }
      if (name === 'evaluator') {
        assert.deepEqual(input.caseIds, ['fixed']);
        const ref = string(input.candidateRef);
        state.evaluated.push(ref);
        const proposal = sequence[Number(ref.slice(1)) - 1]!;
        return {
          action: 'evaluate',
          measurementRef: `m${ref.slice(1)}`,
          status: proposal.evaluable === false ? 'failed' : 'succeeded',
        };
      }
      if (name === 'memoryUpdater') {
        state.memoryCalls ??= [];
        state.memoryCalls.push(input);
        return memory === 'updated'
          ? {
              status: 'updated',
              memoryRef: 'mem-1',
              changeRef: 'change-1',
              reason: 'Recorded this run.',
            }
          : {
              status: 'no-change',
              memoryRef: null,
              changeRef: null,
              reason: 'Nothing new.',
            };
      }
      if (state.selected)
        state.selected.push(string(input.candidateMeasurementRef));
      assert.equal(name, 'selector');
      const a = Number(string(input.incumbentMeasurementRef).slice(1));
      const b = Number(string(input.candidateMeasurementRef).slice(1));
      const incumbent = sequence[a - 1]!;
      const candidate = sequence[b - 1]!;
      // Minimize P50; the feasibility gate is checked before any comparison.
      const accepted = candidate.feasible && candidate.p50 < incumbent.p50;
      return {
        accepted,
        candidateFeasible: candidate.feasible,
        selectedCandidateRef: `c${accepted ? b : a}`,
        measurementRef: `m${accepted ? b : a}`,
        decisionRef: 'decision',
        reason: candidate.feasible ? 'Compared.' : 'Failed the checksum gate.',
        metric: 'p50_us',
        incumbentValue: incumbent.p50,
        candidateValue: candidate.p50,
        selectedValue: (accepted ? candidate : incumbent).p50,
      };
    },
  };
}

async function policyFor(t: TestContext): Promise<Policy> {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  return Policy.load('src/policies/operator-iter-agent/policy.yaml', registry);
}

const config = {
  maxRounds: 10,
  convergeRounds: 2,
  goal: 'Improve the kernel',
  caseIds: ['fixed'],
};

test('operator-iter-agent adopts feasible proposals, measures gate-failing ones and chains parents through the incumbent', async (t) => {
  const policy = await policyFor(t);
  const state = { parents: [], evaluated: [] } as {
    parents: string[];
    evaluated: string[];
  };
  const sequence: Proposal[] = [
    { p50: 90, feasible: true },
    { p50: 40, feasible: false },
    { p50: 80, feasible: true },
    { p50: 85, feasible: true },
    { p50: 84, feasible: true },
  ];
  const checkpoint = { value: {} as JsonObject };
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, checkpoint),
      input: { candidateRef: 'baseline' },
      config,
    }),
  );
  // Round 2 is measured but gate-failing, so the round-3 parent is still c1.
  assert.deepEqual(state.parents, ['baseline', 'c1', 'c1', 'c3', 'c3']);
  assert.deepEqual(
    state.evaluated,
    ['c1', 'c2', 'c3', 'c4', 'c5'],
    'every proposal is measured, including the gate-failing one',
  );
  assert.equal(output.status, 'selected');
  assert.equal(output.candidateRef, 'c3');
  assert.equal(output.measurementRef, 'm3');
  assert.equal(output.bestValue, 80);
  assert.equal(output.stopReason, 'converged');
  assert.deepEqual(output.measurementRefs, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.deepEqual(
    await policy.execute({
      ...stubOptions(state, sequence, checkpoint),
      input: { candidateRef: 'baseline' },
      config,
      restore: checkpoint.value,
      invoke: async () => {
        throw new Error('Completed call repeated');
      },
    }),
    output,
  );
});

test('operator-iter-agent counts no-change rounds as stale and converges', async (t) => {
  const policy = await policyFor(t);
  const state = { parents: [], evaluated: [] } as {
    parents: string[];
    evaluated: string[];
  };
  const sequence: Proposal[] = [
    { p50: 90, feasible: true },
    { p50: 0, feasible: true, noChange: true },
    { p50: 0, feasible: true, noChange: true },
  ];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }),
      input: { candidateRef: 'baseline' },
      config,
    }),
  );
  assert.deepEqual(state.parents, ['baseline', 'c1', 'c1']);
  assert.deepEqual(state.evaluated, ['c1'], 'no-change is never measured');
  assert.equal(output.status, 'selected');
  assert.equal(output.candidateRef, 'c1');
  assert.equal(output.bestValue, 90);
  assert.equal(output.stopReason, 'converged');
  assert.deepEqual(output.measurementRefs, ['m1']);
});

test('operator-iter-agent stops at the round budget with the best incumbent', async (t) => {
  const policy = await policyFor(t);
  const state = { parents: [], evaluated: [] } as {
    parents: string[];
    evaluated: string[];
  };
  const sequence: Proposal[] = [
    { p50: 90, feasible: true },
    { p50: 90, feasible: true },
  ];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }),
      input: { candidateRef: 'baseline' },
      config: { ...config, maxRounds: 2, convergeRounds: 5 },
    }),
  );
  assert.deepEqual(state.evaluated, ['c1', 'c2']);
  assert.equal(output.status, 'selected');
  assert.equal(output.candidateRef, 'c1');
  assert.equal(output.bestValue, 90);
  assert.equal(output.stopReason, 'max-rounds');
});

test('operator-iter-agent counts a failed evaluation as a stale round and never compares it', async (t) => {
  const policy = await policyFor(t);
  const state = {
    parents: [],
    evaluated: [],
    selected: [],
  } as { parents: string[]; evaluated: string[]; selected: string[] };
  const sequence: Proposal[] = [
    { p50: 90, feasible: true },
    { p50: 0, feasible: false, evaluable: false },
  ];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }),
      input: { candidateRef: 'baseline' },
      config: { ...config, maxRounds: 5, convergeRounds: 1 },
    }),
  );
  // The failed measurement is archived in the history but the selector is
  // never asked to compare it, and the incumbent is retained.
  assert.deepEqual(state.evaluated, ['c1', 'c2']);
  assert.deepEqual(
    state.selected,
    ['m1'],
    'a not-evaluable candidate never reaches the selector',
  );
  assert.deepEqual(
    state.parents,
    ['baseline', 'c1'],
    'the failed round leaves the incumbent in place',
  );
  assert.equal(output.status, 'selected');
  assert.equal(output.candidateRef, 'c1');
  assert.equal(output.measurementRef, 'm1');
  assert.equal(output.bestValue, 90);
  assert.equal(output.stopReason, 'converged');
  assert.deepEqual(output.measurementRefs, ['m1', 'm2']);
});

test('operator-iter-agent reports no-feasible-configuration when every proposal fails the gate', async (t) => {
  const policy = await policyFor(t);
  const state = { parents: [], evaluated: [] } as {
    parents: string[];
    evaluated: string[];
  };
  const sequence: Proposal[] = [
    { p50: 40, feasible: false },
    { p50: 35, feasible: false },
  ];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }),
      input: { candidateRef: 'baseline' },
      config: { ...config, maxRounds: 2, convergeRounds: 5 },
    }),
  );
  assert.deepEqual(state.evaluated, ['c1', 'c2']);
  assert.equal(output.status, 'no-feasible-configuration');
  assert.equal(output.candidateRef, null);
  assert.equal(output.measurementRef, null);
  assert.equal(output.bestValue, null);
  assert.equal(output.stopReason, 'max-rounds');
  assert.deepEqual(output.measurementRefs, ['m1', 'm2']);
});

test('operator-iter-agent reflects into memory at finish and carries the memoryRef in its output', async (t) => {
  const policy = await policyFor(t);
  const state = {
    parents: [],
    evaluated: [],
    memoryCalls: [],
  } as {
    parents: string[];
    evaluated: string[];
    memoryCalls: JsonObject[];
  };
  const sequence: Proposal[] = [
    { p50: 90, feasible: true },
    { p50: 80, feasible: true },
  ];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }),
      input: { candidateRef: 'baseline' },
      config: { ...config, maxRounds: 2, convergeRounds: 5 },
    }),
  );
  // Exactly one memory call, fed the run's measurement history.
  assert.deepEqual(
    state.memoryCalls.map((call) => call.memoryRef),
    [null],
  );
  assert.deepEqual(state.memoryCalls[0]!.evidenceRefs, ['m1', 'm2']);
  assert.equal(output.memoryRef, 'mem-1');
});

test('operator-iter-agent keeps memoryRef null when the memory agent reports no change', async (t) => {
  const policy = await policyFor(t);
  const state = {
    parents: [],
    evaluated: [],
    memoryCalls: [],
  } as {
    parents: string[];
    evaluated: string[];
    memoryCalls: JsonObject[];
  };
  const sequence: Proposal[] = [{ p50: 90, feasible: true }];
  const output = object(
    await policy.execute({
      ...stubOptions(state, sequence, { value: {} }, 'no-change'),
      input: { candidateRef: 'baseline' },
      config: { ...config, maxRounds: 1, convergeRounds: 5 },
    }),
  );
  assert.deepEqual(
    state.memoryCalls.map((call) => call.evidenceRefs),
    [['m1']],
  );
  assert.equal(output.memoryRef, null);
});
