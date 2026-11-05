import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/policy.js';
import {
  agentContract,
  operatorbenchContract,
  operatorProposerContract,
  metricSelectorContract,
} from '../../src/contracts/index.js';

test('the operator Policy loads and round-trip through the unified model', async () => {
  const registry = new Registry();
  for (const contract of [
    agentContract,
    operatorbenchContract,
    operatorProposerContract,
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
        Policy.fromJSON(declaration, { contracts: registry }).digest,
        policy.digest,
      );
      if (name === 'operator-search') {
        assert.equal(
          policy.stateInitial.bestCandidateRef,
          '${{ input.candidateRef }}',
        );
        assert.equal(policy.stateInitial.baselineMeasurement, null);
        assert.equal(
          policy.steps.filter((step) => step.type === 'loop').length,
          1,
        );
      }
    }
  } finally {
    await registry.dispose();
  }
});
