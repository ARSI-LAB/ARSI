import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

for (const stopAfterFirst of [false, true]) {
  test(
    stopAfterFirst
      ? 'parameter.agent drops the batch tail when the next trial no longer fits the budget'
      : 'parameter.agent finishes a batch before proposing from the measured incumbent',
    async () => {
      const registry = new Registry();
      try {
        await registerBuiltins(registry);
        const policy = await Policy.load(
          registry.policy('parameter.agent'),
          registry,
        );
        const events: string[] = [];
        let frameworkTrialChecks = 0;
        const result = object(
          await policy.execute({
            context: new RuntimeContext().extend({
              signal: new AbortController().signal,
            }),
            application: {},
            checkpoint: async () => {},
            input: { candidateRef: 'original' },
            config: { maxTrials: 3, candidatesPerRound: 2 },
            timeBudget: async (request) => {
              if (request.stage === 'framework' && request.actions.length === 1)
                frameworkTrialChecks++;
              const fits = !stopAfterFirst || frameworkTrialChecks < 2;
              return {
                fits,
                estimatedMs: 1,
                remainingMs: fits ? 10 : 0,
                reason: fits ? 'fits' : 'stage-time',
              };
            },
            async invoke(binding, raw): Promise<JsonObject> {
              const input = object(raw);
              events.push(
                `${binding}:${input.candidateRef ?? input.parent ?? input.candidateMeasurementRef}`,
              );
              if (binding === 'trial') {
                const candidate = String(input.candidateRef);
                if (['original', 'bad'].includes(candidate))
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
                assert.equal(input.maxCandidates, 1);
                assert.deepEqual(input.evidenceRefs, ['m-ready', 'm-best']);
                assert.deepEqual(input.sources, [
                  { candidateRef: 'ready' },
                  { candidateRef: 'bad' },
                  { candidateRef: 'best' },
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
          ...(stopAfterFirst
            ? []
            : ['trial:best', 'selector:m-best', 'proposer:best']),
        ]);
        assert.equal(
          result.status,
          stopAfterFirst ? 'no-feasible-configuration' : 'selected',
        );
        assert.equal(
          result.stopReason,
          stopAfterFirst ? 'time-budget' : 'no-change',
        );
        assert.equal(result.baselineCandidateRef, 'ready');
        assert.equal(result.baselineMeasurementRef, 'm-ready');
        assert.equal(result.candidateRef, stopAfterFirst ? null : 'best');
        assert.equal(result.measurementRef, stopAfterFirst ? null : 'm-best');
      } finally {
        await registry.dispose();
      }
    },
  );
}
