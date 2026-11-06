import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type {
  JsonObject,
  OperationDefinition,
  OperatorProposerInput,
  OperatorProposerOutput,
} from '../../src/contracts/index.js';
import { operatorProposerContract } from '../../src/contracts/plugin-types/proposer-operator.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { operatorbenchDefinition } from '../../src/plugins/evaluator-operatorbench/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';

test('static search compiles with the operator three-action contract and the declared indirect Agent capability', async () => {
  const registry = new Registry();
  const definition: OperationDefinition<
    OperatorProposerInput,
    OperatorProposerOutput,
    JsonObject
  > = {
    id: 'proposer.operator',
    contract: operatorProposerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          throw new Error('Compilation must not execute business plugins');
        },
        async dispose() {},
      };
    },
  };
  registry.registerOperation(piDefinition);
  registry.registerOperation(definition);
  registry.registerOperation(operatorbenchDefinition);
  registry.registerOperation(metricSelectorDefinition);
  try {
    const policy = await Policy.load(
      resolve('src/policies/operator-search/policy.yaml'),
      registry,
    );
    assert.deepEqual(Object.keys(policy.requirements).sort(), [
      'agent',
      'evaluator',
      'proposer',
      'selector',
    ]);
    assert.equal(
      policy.requirements.proposer!.id,
      'contract.proposer-operator',
    );
  } finally {
    await registry.dispose();
  }
});
