import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationContract,
  defineContract,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { compilePolicy } from '../../src/runtime/compiler/index.js';

test('Policy bindings cannot select registered Policies as child plugins', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerOperation({
    id: 'application.test',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      throw new Error('Assembly must not create instances');
    },
  });
  registry.registerContract(
    defineContract({
      id: 'contract.child',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
  );
  registry.registerPolicy('policy.child', '/unread-child.yaml');
  const policy = compilePolicy(
    {
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.parent',
      input_schema: { type: 'object' },
      output_schema: true,
      require: { child: { contract: 'contract.child' } },
      defaults: { bindings: { child: { plugin: 'policy.child' } } },
      steps: [],
      output: null,
    },
    { contracts: registry },
  );
  await assert.rejects(
    Recipe.fromJSON(
      {
        schemaVersion: 'rsi.recipe/v1',
        id: 'recipe.parent',
        application: { plugin: 'application.test' },
        policy: { id: policy.id },
      },
      registry,
      { policy },
    ),
    /Unknown plugin policy.child/,
  );
});
