import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

test('parameter.agent follows selector decisions and returns the measured incumbent before constraints are met', async () => {
  const registry = new Registry();
  try {
    await registerBuiltins(registry);
    const policy = await Policy.load(
      registry.policy('parameter.agent'),
      registry,
    );
    const events: string[] = [];
    const result = object(
      await policy.execute({
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        application: {},
        checkpoint: async () => {},
        input: { candidateRef: 'baseline' },
        config: { maxTrials: 4, candidatesPerRound: 2 },
        async invoke(binding, raw): Promise<JsonObject> {
          const input = object(raw);
          events.push(
            `${binding}:${input.candidateRef ?? input.parent ?? input.candidateMeasurementRef}`,
          );
          if (binding === 'evaluator') {
            return { measurementRef: `m-${input.candidateRef}` };
          }
          if (binding === 'proposer') {
            if (input.parent === 'baseline') {
              assert.equal(input.maxCandidates, 2);
              assert.deepEqual(input.evidenceRefs, ['m-baseline']);
              assert.deepEqual(input.sources, [{ candidateRef: 'baseline' }]);
              return {
                status: 'batch',
                candidates: [
                  {
                    candidateRef: 'rejected',
                    diffRef: 'rejected-diff',
                    rationale: 'Try a larger batch',
                  },
                  {
                    candidateRef: 'progress',
                    diffRef: 'progress-diff',
                    rationale: 'Try a smaller batch',
                  },
                ],
              };
            }
            if (input.maxCandidates === 2) {
              assert.equal(input.parent, 'progress');
              assert.deepEqual(input.evidenceRefs, [
                'm-baseline',
                'm-rejected',
                'm-progress',
              ]);
              return {
                status: 'created',
                candidateRef: 'single',
                diffRef: 'single-diff',
                rationale: 'Try one more parameter set',
              };
            }
            assert.equal(input.parent, 'single');
            assert.equal(input.maxCandidates, 1);
            assert.deepEqual(input.sources, [
              { candidateRef: 'baseline' },
              { candidateRef: 'rejected' },
              { candidateRef: 'progress' },
              { candidateRef: 'single' },
            ]);
            assert.match(
              JSON.stringify(input.observations),
              /Constraints improved/,
            );
            return {
              status: 'no-change',
              candidateRef: 'single',
              diffRef: null,
              rationale: 'No untried options',
            };
          }
          assert.equal(binding, 'selector');
          const candidate = String(input.candidateMeasurementRef).slice(2);
          const accepted = ['progress', 'single'].includes(candidate);
          assert.equal(
            input.incumbentMeasurementRef,
            candidate === 'single' ? 'm-progress' : 'm-baseline',
          );
          const selected = accepted ? candidate : 'baseline';
          return {
            accepted,
            candidateFeasible: candidate === 'rejected',
            selectedCandidateRef: selected,
            reason: accepted ? 'Constraints improved' : 'Retain incumbent',
            decisionRef: 'decision',
            measurementRef: `m-${selected}`,
            metric: 'requestThroughput',
            incumbentValue: 10,
            candidateValue: 9,
            selectedValue: 10,
          };
        },
      }),
    );
    assert.deepEqual(events, [
      'evaluator:baseline',
      'selector:m-baseline',
      'proposer:baseline',
      'evaluator:rejected',
      'selector:m-rejected',
      'evaluator:progress',
      'selector:m-progress',
      'proposer:progress',
      'evaluator:single',
      'selector:m-single',
      'proposer:single',
    ]);
    assert.equal(result.status, 'no-feasible-configuration');
    assert.equal(result.candidateFeasible, false);
    assert.equal(result.stopReason, 'no-change');
    assert.equal(result.baselineCandidateRef, 'baseline');
    assert.equal(result.baselineMeasurementRef, 'm-baseline');
    assert.equal(result.candidateRef, 'single');
    assert.equal(result.measurementRef, 'm-single');
    assert.ok(Array.isArray(result.trials));
    assert.deepEqual(
      result.trials.map((trial) => object(trial).accepted),
      [false, true, true],
    );
    assert.deepEqual(
      result.trials.map((trial) => object(trial).candidateFeasible),
      [true, false, false],
    );
  } finally {
    await registry.dispose();
  }
});
