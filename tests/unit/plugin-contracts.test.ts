import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { Registry } from '../../src/runtime/registry/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { proposerContract } from '../../src/contracts/plugin-types/index.js';
import { proposerDefinition } from '../../src/plugins/proposer-agent/index.js';
import {
  RuntimeContext,
  type OperationDefinition,
} from '../../src/contracts/index.js';

test('implementations share a fixed public type and reject conflicting declarations or invalid output unions', async () => {
  const registry = new Registry();
  const definition: OperationDefinition = {
    id: 'test.proposer',
    contract: proposerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          return {
            status: 'created',
            candidateRef: 'candidate',
            diffRef: null,
            rationale: 'Invalid created result',
          };
        },
        async dispose() {},
      };
    },
  };
  try {
    registry.registerOperation(definition);
    registry.registerOperation({ ...definition, id: 'test.other-proposer' });
    assert.equal(registry.get(definition.id).contract.id, proposerContract.id);
    assert.throws(
      () =>
        registry.registerOperation({
          ...definition,
          id: 'test.conflicting',
          contract: { ...proposerContract, output_schema: { type: 'string' } },
        }),
      /conflicting.*contract|contract.*conflict/i,
    );
    const operation = await registry
      .get(definition.id)
      .create({}, {} as RuntimeContext);
    const context: RuntimeContext = new RuntimeContext().extend({
      experimentId: 'test',
      callId: 'test',
      bindingId: 'test',
      idempotencyKey: 'test',
      directory: '/unused',
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    });
    await assert.rejects(
      operation.execute(
        { parent: 'candidate', goal: 'Improve', evidenceRefs: [] },
        context,
      ),
      /output/,
    );
    await operation.dispose();
  } finally {
    await registry.dispose();
  }
});

test('wrong public types fail validation and actual startup before calls while another implementation is substitutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-contract-'));
  const runtime = await createRuntime({ rootDirectory: root });
  try {
    const loaded = await Recipe.load(
      resolve('examples/harness/dsh-harness2/recipe.yaml'),
      runtime.registry,
    );
    const recipe = loaded.toJSON();
    const bindings =
      recipe.bindings as import('../../src/contracts/index.js').JsonObject;
    bindings.invariantProposer = {
      plugin: 'memory.agent',
      config: { prompt: resolve('src/policies/harness2/memory.md') },
    };
    const path = join(root, 'recipe.yaml');
    await writeFile(path, stringify(recipe));
    await assert.rejects(
      Recipe.load(path, runtime.registry),
      /invariantProposer.*contract|contract.*invariantProposer/i,
    );
    await assert.rejects(
      runtime.manager.run(path, { id: 'wrong-type' }),
      /invariantProposer.*contract|contract.*invariantProposer/i,
    );
    assert.deepEqual(await runtime.manager.facts.list('calls'), []);
    runtime.registry.registerOperation({
      ...proposerDefinition,
      id: 'proposer.alternative',
    });
    bindings.invariantProposer = {
      plugin: 'proposer.alternative',
      config: {
        prompt: resolve('src/policies/harness2/prompts/invariant.md'),
        guidance: resolve('src/policies/harness2/guidance/invariant-proposer'),
        agentRef: 'agent',
      },
    };
    await writeFile(path, stringify(recipe));
    assert.equal(
      (await Recipe.load(path, runtime.registry)).bindings.invariantProposer
        ?.pluginId,
      'proposer.alternative',
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('Policy requirements resolve registered contract IDs and report unknown IDs with binding context', async (t) => {
  const { Policy } = await import('../../src/runtime/policy/index.js');
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerContract(proposerContract);
  const definition = {
    schemaVersion: 'rsi.policy/v1',
    id: 'policy.contract-id',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: { editor: { contract: proposerContract.id } },
    steps: [],
    output: {},
  };
  const policy = new Policy(definition, { contracts: registry });
  assert.deepEqual(policy.requirements.editor, proposerContract);
  const custom = { ...proposerContract, id: 'contract.custom-proposer' };
  registry.registerContract(custom);
  const customDefinition = {
    ...definition,
    require: { editor: { contract: custom.id } },
  };
  const customPolicy = new Policy(customDefinition, {
    contracts: registry,
  });
  assert.deepEqual(customPolicy.requirements.editor, custom);
  const otherRegistry = new Registry();
  t.after(() => otherRegistry.dispose());
  otherRegistry.registerContract({
    ...custom,
    output_schema: { type: 'string' },
  });
  assert.notEqual(
    customPolicy.digest,
    new Policy(customDefinition, { contracts: otherRegistry }).digest,
    'compiled identity includes the resolved contract contents',
  );
  assert.throws(
    () =>
      new Policy(
        {
          ...definition,
          require: { editor: { contract: 'contract.unknown' } },
        },
        { contracts: registry },
      ),
    /require.editor.*Unknown contract.*contract.unknown/,
  );
  assert.throws(
    () =>
      new Policy(
        { ...definition, require: { editor: { contract: proposerContract } } },
        { contracts: registry },
      ),
    /require.editor.contract.*string/,
  );
});
