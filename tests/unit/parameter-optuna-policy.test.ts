import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext } from '../../src/contracts/index.js';
import { parameterSearchProposerContract } from '../../src/contracts/plugin-types/proposer-parameter-search.js';
import { inferencebenchContract } from '../../src/contracts/plugin-types/inferencebench.js';
import { metricSelectorContract } from '../../src/contracts/plugin-types/selector-metrics.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';
import type { JsonObject } from '../../src/contracts/index.js';

test('Optuna Policy feeds every measured result back before the next proposal and recovers checkpoints', async () => {
  const registry = new Registry();
  for (const contract of [
    parameterSearchProposerContract,
    inferencebenchContract,
    metricSelectorContract,
  ])
    registry.registerContract(contract);
  try {
    const policy = await Policy.load(
      'src/policies/parameter-optuna/policy.yaml',
      registry,
    );
    const calls: string[] = [];
    let checkpoint: JsonObject = {};
    const output = object(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxTrials: 4 },
        application: {},
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        checkpoint: async (value) => {
          checkpoint = value;
        },

        invoke: async (binding, raw): Promise<JsonObject> => {
          const input = object(raw);
          if (binding === 'proposer') {
            calls.push(string(input.action));
            if (input.action === 'initialize')
              return { action: 'initialize', stateRef: 's0' };
            if (input.action === 'observe')
              return {
                action: 'observe',
                stateRef: `s${Number(string(input.trialId)) + 1}`,
              };
            const i = Number(string(input.stateRef).slice(1));
            if (i === 3)
              return {
                action: 'suggest',
                status: 'stopped',
                stateRef: 's3',
                reason: 'search-exhausted',
              };
            return {
              action: 'suggest',
              status: 'candidate',
              stateRef: `pending${i}`,
              trialId: String(i),
              candidateRef: `c${i}`,
              parameters: { x: i },
            };
          }
          if (binding === 'evaluator') {
            calls.push('evaluate');
            return {
              measurementRef: `m${string(input.candidateRef).slice(1)}`,
            };
          }
          calls.push('select');
          const i = Number(string(input.candidateMeasurementRef).slice(1));
          const accepted = i === 1;
          return {
            accepted,
            candidateFeasible: i > 0,
            selectedCandidateRef: accepted ? 'c1' : `c${i}`,
            measurementRef: accepted ? 'm1' : `m${i}`,
            decisionRef: `d${i}`,
            reason: 'Compared',
            metric: 'throughput',
            incumbentValue: 1,
            candidateValue: 1,
            selectedValue: 1,
          };
        },
      }),
    );
    assert.deepEqual(calls, [
      'initialize',
      'suggest',
      'evaluate',
      'select',
      'observe',
      'suggest',
      'evaluate',
      'select',
      'observe',
      'suggest',
      'evaluate',
      'select',
      'observe',
      'suggest',
    ]);
    assert.equal(output.candidateRef, 'c1');
    assert.equal(output.stopReason, 'search-exhausted');
    assert.deepEqual(output.measurementRefs, ['m0', 'm1', 'm2']);
    assert.equal(output.searchStateRef, 's3');
    assert.deepEqual(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxTrials: 4 },
        application: {},
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        restore: checkpoint,
        checkpoint: async () => {},

        invoke: async () => {
          throw new Error('Completed call repeated');
        },
      }),
      output,
    );
  } finally {
    await registry.dispose();
  }
});
