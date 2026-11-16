import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/policy.js';
import {
  agentContract,
  operatorbenchContract,
  operatorProposerContract,
  operatorSummarizerContract,
  metricSelectorContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';

function loopIds(steps: readonly JsonObject[]): string[] {
  const found: string[] = [];
  for (const step of steps) {
    if (step.type === 'loop') found.push(String(step.id));
    if (step.type === 'loop' || step.type === 'foreach') {
      const inner = step.steps;
      if (Array.isArray(inner))
        found.push(...loopIds(inner.map((value) => object(value))));
    }
    if (step.type === 'if')
      for (const branch of [step.then, step.else]) {
        const inner = object(branch).steps;
        if (Array.isArray(inner))
          found.push(...loopIds(inner.map((value) => object(value))));
      }
  }
  return found;
}

test('the operator Policy loads and round-trip through the unified model', async () => {
  const registry = new Registry();
  for (const contract of [
    agentContract,
    operatorbenchContract,
    operatorProposerContract,
    operatorSummarizerContract,
    metricSelectorContract,
  ])
    registry.registerContract(contract);
  try {
    for (const name of ['operator-search']) {
      const policy = await Policy.load(
        resolve(`src/policies/${name}/policy.yaml`),
        registry,
      );
      const declaration = policy.toJSON();
      assert.equal(declaration.init, undefined);
      assert.equal(declaration.loop, undefined);
      assert.equal(declaration.finish, undefined);
      assert.ok(policy.steps.length > 0);
      assert.equal(
        new Policy(declaration, { contracts: registry }).digest,
        policy.digest,
      );
      if (name === 'operator-search') {
        assert.equal(
          policy.stateInitial.bestCandidateRef,
          '${{ input.candidateRef }}',
        );
        assert.equal(policy.stateInitial.baselineMeasurement, null);
        const loops = loopIds(policy.steps.map((step) => step.toJSON()));
        for (const id of [
          'static_search',
          'repair_loop',
          'metrics_loop',
          'metrics_repair_loop',
        ])
          assert.ok(loops.includes(id), `missing loop ${id}`);
      }
    }
  } finally {
    await registry.dispose();
  }
});
