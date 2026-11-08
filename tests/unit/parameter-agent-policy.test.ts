import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

test('parameter.agent finishes a batch before proposing from the measured incumbent', async () => {
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
        input: { candidateRef: 'original' },
        config: { maxTrials: 4, candidatesPerRound: 2 },
        async invoke(binding, raw): Promise<JsonObject> {
          const input = object(raw);
          events.push(
            `${binding}:${input.candidateRef ?? input.parent ?? input.candidateMeasurementRef}`,
          );
          if (binding === 'trial') {
            const candidate = String(input.candidateRef);
            if (['original', 'bad', 'single'].includes(candidate))
              return {
                status: 'startup-failed',
                measurementRef: null,
                reason: 'Startup was rejected',
              };
            return {
              status: 'measured',
              measurementRef: `m-${candidate}`,
              reason: null,
            };
          }
          if (binding === 'repair') {
            assert.deepEqual(input.observations, {
              baseline: {
                status: 'startup-failed',
                reason: 'Startup was rejected',
              },
            });
            return {
              status: 'created',
              candidateRef: 'ready',
              diffRef: 'repair-diff',
              rationale: 'Reduce memory pressure',
            };
          }
          if (binding === 'proposer') {
            if (input.parent === 'ready') {
              assert.equal(input.maxCandidates, 2);
              assert.deepEqual(input.evidenceRefs, ['m-ready']);
              assert.deepEqual(input.sources, [{ candidateRef: 'ready' }]);
              return {
                status: 'batch',
                candidates: [
                  {
                    candidateRef: 'bad',
                    diffRef: 'bad-diff',
                    rationale: 'Try a larger batch',
                  },
                  {
                    candidateRef: 'best',
                    diffRef: 'best-diff',
                    rationale: 'Try a smaller batch',
                  },
                ],
              };
            }
            assert.equal(input.parent, 'best');
            assert.deepEqual(input.evidenceRefs, ['m-ready', 'm-best']);
            if (input.maxCandidates === 2)
              return {
                status: 'created',
                candidateRef: 'single',
                diffRef: 'single-diff',
                rationale: 'Try one more parameter set',
              };
            assert.equal(input.maxCandidates, 1);
            assert.deepEqual(input.sources, [
              { candidateRef: 'ready' },
              { candidateRef: 'bad' },
              { candidateRef: 'best' },
              { candidateRef: 'single' },
            ]);
            assert.match(
              JSON.stringify(input.observations),
              /Startup was rejected/,
            );
            return {
              status: 'no-change',
              candidateRef: 'best',
              diffRef: null,
              rationale: 'No untried options',
            };
          }
          assert.equal(binding, 'selector');
          const candidate =
            input.candidateMeasurementRef === 'm-best' ? 'best' : 'ready';
          return {
            accepted: false,
            candidateFeasible: candidate === 'best',
            selectedCandidateRef: 'ready',
            reason: 'Compared',
            decisionRef: 'decision',
            measurementRef: 'm-ready',
            metric: 'requestThroughput',
            incumbentValue: 10,
            candidateValue: 9,
            selectedValue: 10,
          };
        },
      }),
    );
    assert.deepEqual(events, [
      'trial:original',
      'repair:original',
      'trial:ready',
      'selector:m-ready',
      'proposer:ready',
      'trial:bad',
      'trial:best',
      'selector:m-best',
      'proposer:best',
      'trial:single',
      'proposer:best',
    ]);
    assert.equal(result.status, 'selected');
    assert.equal(result.stopReason, 'no-change');
    assert.equal(result.baselineCandidateRef, 'ready');
    assert.equal(result.baselineMeasurementRef, 'm-ready');
    assert.equal(result.candidateRef, 'best');
    assert.equal(result.measurementRef, 'm-best');
  } finally {
    await registry.dispose();
  }
});
