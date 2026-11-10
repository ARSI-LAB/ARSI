import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { operatorProposerDefinition } from '../../src/plugins/proposer-operator/index.js';
import { operatorSummarizerDefinition } from '../../src/plugins/summarizer-operator/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { operatorbenchDefinition } from '../../src/plugins/evaluator-operatorbench/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';

test('static search compiles with the independent proposer and summarizer contracts and the declared indirect Agent capability', async () => {
  const registry = new Registry();
  registry.registerOperation(piDefinition);
  registry.registerOperation(operatorProposerDefinition);
  registry.registerOperation(operatorSummarizerDefinition);
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
      'summarizer',
    ]);
    assert.equal(
      policy.requirements.proposer!.id,
      'contract.proposer-operator',
    );
    assert.equal(
      policy.requirements.summarizer!.id,
      'contract.summarizer-operator',
    );
  } finally {
    await registry.dispose();
  }
});
