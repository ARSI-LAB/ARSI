import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

async function loadGymPolicy(t: TestContext): Promise<Policy> {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  return Policy.load('src/policies/gym-rsi/policy.yaml', registry);
}

function policyConfig(): JsonObject {
  return {
    maxRounds: 1,
    dataset: {
      trainTaskIds: ['train'],
      validationTaskIds: ['val'],
      testTaskIds: [],
    },
  };
}

test('policy.gym-rsi releases after search and exposes the effective candidate', async (t) => {
  const policy = await loadGymPolicy(t);
  const calls: { name: string; input: JsonObject }[] = [];
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        calls.push({ name, input });
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return { measurementRef: taskId === 'train' ? 'm-train' : 'm-val' };
        }
        if (name === 'memoryUpdater')
          return {
            status: 'updated',
            memoryRef: 'wiki',
            changeRef: 'memory-change',
            reason: 'Training evidence recorded.',
          };
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: true,
            candidateFeasible: true,
            selectedCandidateRef: 'c1',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation improved.',
            metric: 'successRate',
            incumbentValue: 0.5,
            candidateValue: 0.8,
            selectedValue: 0.8,
          };
        if (name === 'release') {
          assert.deepEqual(input, {
            candidateRef: 'c1',
            incumbentRef: 'h0',
          });
          return {
            decision: 'promote',
            reason: 'Candidate strictly beats incumbent on holdout.',
            releaseRef: 'artifact:release',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.equal(calls.at(-1)!.name, 'release');
  assert.deepEqual(
    calls.find((call) => call.name === 'memoryUpdater')!.input.evidenceRefs,
    ['m-train'],
  );
  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'c1');
  assert.equal(result.candidateRef, 'c1');
  assert.equal(result.releaseDecision, 'promote');
  assert.equal(result.releaseRef, 'artifact:release');
});

test('policy.gym-rsi keeps the original incumbent effective when promotion is declined', async (t) => {
  const policy = await loadGymPolicy(t);
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return { measurementRef: taskId === 'train' ? 'm-train' : 'm-val' };
        }
        if (name === 'memoryUpdater')
          return {
            status: 'no-change',
            memoryRef: input.memoryRef,
            changeRef: null,
            reason: 'No update.',
          };
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: true,
            candidateFeasible: true,
            selectedCandidateRef: 'c1',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation improved.',
            metric: 'successRate',
            incumbentValue: 0.5,
            candidateValue: 0.8,
            selectedValue: 0.8,
          };
        if (name === 'release')
          return {
            decision: 'keep-incumbent',
            reason: 'Holdout did not improve.',
            releaseRef: 'artifact:release',
          };
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'h0');
  assert.equal(result.candidateRef, 'h0');
  assert.equal(result.releaseDecision, 'keep-incumbent');
});

test('policy.gym-rsi always runs its explicit release step', async (t) => {
  const policy = await loadGymPolicy(t);
  const releases: JsonObject[] = [];
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') return { measurementRef: 'm-train' };
        if (name === 'memoryUpdater')
          return {
            status: 'no-change',
            memoryRef: input.memoryRef,
            changeRef: null,
            reason: 'No update.',
          };
        if (name === 'proposer')
          return {
            status: 'no-change',
            candidateRef: 'h0',
            diffRef: null,
            rationale: 'No edit.',
          };
        if (name === 'release') {
          releases.push(input);
          return {
            decision: 'keep-incumbent',
            reason: 'No candidate to promote.',
            releaseRef: 'artifact:release',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(releases, [{ candidateRef: 'h0', incumbentRef: 'h0' }]);
  assert.equal(result.searchCandidateRef, 'h0');
  assert.equal(result.effectiveRef, 'h0');
  assert.equal(result.releaseDecision, 'keep-incumbent');
});

test('policy.gym-rsi advances a tied candidate to holdout', async (t) => {
  const policy = await loadGymPolicy(t);
  let releaseInput: JsonObject | null = null;
  const result = object(
    await policy.execute({
      input: { candidateRef: 'h0' },
      config: policyConfig(),
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      invoke: async (name, raw): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'evaluator') {
          const taskId = (input.taskIds as string[])[0];
          return { measurementRef: taskId === 'train' ? 'm-train' : 'm-val' };
        }
        if (name === 'memoryUpdater')
          return {
            status: 'no-change',
            memoryRef: input.memoryRef,
            changeRef: null,
            reason: 'No update.',
          };
        if (name === 'proposer')
          return {
            status: 'created',
            candidateRef: 'c1',
            diffRef: 'diff',
            rationale: 'Improve the skill.',
          };
        if (name === 'selector')
          return {
            accepted: false,
            candidateFeasible: true,
            selectedCandidateRef: 'h0',
            measurementRef: 'm-val',
            decisionRef: 'decision',
            reason: 'Validation tied.',
            metric: 'successRate',
            incumbentValue: 1,
            candidateValue: 1,
            selectedValue: 1,
          };
        if (name === 'release') {
          releaseInput = input;
          return {
            decision: 'promote',
            reason: 'Candidate beats incumbent on holdout.',
            releaseRef: 'artifact:release',
          };
        }
        throw new Error(`unexpected binding ${name}`);
      },
    }),
  );

  assert.deepEqual(releaseInput, { candidateRef: 'c1', incumbentRef: 'h0' });
  assert.equal(result.searchCandidateRef, 'c1');
  assert.equal(result.effectiveRef, 'c1');
  assert.equal(result.releaseDecision, 'promote');
});
