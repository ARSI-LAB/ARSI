import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { applicationContract } from '../../src/contracts/plugin-types/application.js';
import { reflectionContract } from '../../src/contracts/plugin-types/reflection.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { readYaml } from '../../src/runtime/loaders/yaml.js';
import { object } from '../../src/shared/json.js';
import type {
  JsonSchema,
  OperationDefinition,
} from '../../src/contracts/index.js';
import { defineContract } from '../../src/contracts/contract.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Binding } from '../../src/runtime/loaders/binding.js';

const contract = defineContract({
  id: 'contract.binding-test',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
});

function register(
  registry: Registry,
  id: string,
  configSchema: JsonSchema,
): void {
  const definition: OperationDefinition = {
    id,
    contract,
    configSchema,
    async create() {
      throw new Error('Loading must not create plugins');
    },
  };
  registry.registerOperation(definition);
}

test('Binding merges nested declarations before applying defaults and keeps leaf path origins', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  register(registry, 'worker', {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: {
          inherited: { type: 'string', 'x-rsi-path': 'file' },
          override: { type: 'string', 'x-rsi-path': 'file' },
          defaulted: { type: 'string', default: 'final' },
          literal: { type: 'string' },
        },
        required: ['inherited', 'override', 'defaulted'],
        additionalProperties: false,
      },
      paths: { type: 'array', items: { type: 'string', 'x-rsi-path': 'file' } },
      nullable: { type: ['object', 'null'] },
    },
    required: ['nested'],
    additionalProperties: false,
  });
  const defaults = {
    plugin: 'worker',
    config: {
      nested: { inherited: './a', override: './b', literal: './literal' },
      paths: ['./old'],
      nullable: { old: true },
    },
  };
  const override = {
    config: {
      nested: { override: './new' },
      paths: ['./replacement'],
      nullable: null,
    },
  };
  const binding = Binding.resolve({
    name: 'worker',
    required: contract,
    registry,
    defaults: { declaration: defaults, directory: resolve('fixtures/policy') },
    override: { declaration: override, directory: resolve('fixtures/recipe') },
  });
  assert.deepEqual(binding.config, {
    nested: {
      inherited: resolve('fixtures/policy/a'),
      override: resolve('fixtures/recipe/new'),
      defaulted: 'final',
      literal: './literal',
    },
    paths: [resolve('fixtures/recipe/replacement')],
    nullable: null,
  });
  assert.equal(defaults.config.nested.override, './b');
  assert.equal(Object.hasOwn(defaults.config.nested, 'defaulted'), false);
  assert.equal(binding.pluginId, 'worker');
  assert.deepEqual(binding.toJSON(), {
    plugin: 'worker',
    config: binding.config,
  });
  assert.throws(() => {
    binding.config.nested = {};
  }, TypeError);
  const saved = binding.toJSON();
  saved.config.nested = {};
  assert.notDeepEqual(saved.config, binding.config);
});

test('Binding switches discard incompatible old config and withConfig validates a full immutable replacement', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  register(registry, 'old-worker', {
    type: 'object',
    properties: { old: { type: 'boolean' } },
  });
  register(registry, 'new-worker', {
    type: 'object',
    properties: { count: { type: 'integer', default: 2 } },
    required: ['count'],
    additionalProperties: false,
  });
  const binding = Binding.resolve({
    name: 'worker',
    required: contract,
    registry,
    defaults: {
      declaration: { plugin: 'old-worker', config: { old: true } },
      directory: '.',
    },
    override: { declaration: { plugin: 'new-worker' }, directory: '.' },
  });
  assert.deepEqual(binding.config, { count: 2 });
  const replacement = binding.withConfig({ count: 3 });
  assert.deepEqual(replacement.config, { count: 3 });
  assert.deepEqual(binding.config, { count: 2 });
  assert.throws(() => binding.withConfig({ count: -0.5 }), /worker/);
});

test('Binding rejects incomplete, legacy, invalid and contract-mismatched declarations at assembly', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  register(registry, 'worker', { type: 'object', additionalProperties: false });
  for (const declaration of [
    {},
    { ref: 'worker' },
    { plugin: 'worker', config: null },
    { plugin: 'worker', bindings: {} },
  ]) {
    assert.throws(
      () =>
        Binding.resolve({
          name: 'missing-worker',
          required: contract,
          registry,
          override: { declaration, directory: '.' },
        }),
      /missing-worker/,
    );
  }
  assert.throws(
    () =>
      Binding.resolve({
        name: 'wrong-worker',
        required: { ...contract, id: 'contract.other' },
        registry,
        override: { declaration: { plugin: 'worker' }, directory: '.' },
      }),
    /requires contract/,
  );
});

async function recipeFixture(t: test.TestContext): Promise<{
  registry: Registry;
  directory: string;
  recipe: Record<string, unknown>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-recipe-binding-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  registry.registerOperation({
    id: 'application.test',
    contract: applicationContract,
    configSchema: {
      type: 'object',
      properties: { source: { type: 'string', 'x-rsi-path': 'file' } },
    },
    async create() {
      throw new Error('Recipe loading created Application');
    },
  });
  register(registry, 'worker', {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: {
          inherited: { type: 'string', 'x-rsi-path': 'file' },
          overridden: { type: 'string', 'x-rsi-path': 'file' },
        },
      },
    },
    additionalProperties: false,
  });
  const policyPath = join(directory, 'policy.yaml');
  await writeFile(
    policyPath,
    stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.test',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      config_schema: {
        type: 'object',
        properties: {
          rounds: { type: 'integer', default: 2 },
          file: { type: 'string', 'x-rsi-path': 'file' },
        },
        additionalProperties: false,
      },
      require: { worker: { contract: contract.id } },
      defaults: {
        bindings: {
          worker: {
            plugin: 'worker',
            config: {
              nested: { inherited: './inherited', overridden: './old' },
            },
          },
        },
      },
      steps: [],
      output: {},
    }),
  );
  registry.registerPolicy('policy.test', policyPath);
  return {
    registry,
    directory,
    recipe: {
      schemaVersion: 'rsi.recipe/v1',
      id: 'recipe.test',
      description: 'Assembly test',
      application: {
        plugin: 'application.test',
        config: { source: './source' },
      },
      policy: {
        id: 'policy.test',
        config: { file: './input' },
        input: { candidate: '${{ application.initialCandidate }}' },
      },
      bindings: { worker: { config: { nested: { overridden: './new' } } } },
      budget: { modelCalls: 0, operations: 10 },
    },
  };
}

test('Recipe assembles registered definitions, prepares paths/defaults and preserves input templates without execution', async (t) => {
  const { registry, directory, recipe: raw } = await recipeFixture(t);
  const path = join(directory, 'recipe.yaml');
  await writeFile(path, stringify(raw));
  const recipe = await Recipe.load(path, registry);
  assert.equal(recipe.policy.id, 'policy.test');
  assert.deepEqual(recipe.policyConfig, {
    file: join(directory, 'input'),
    rounds: 2,
  });
  assert.deepEqual(recipe.policyInput, {
    candidate: '${{ application.initialCandidate }}',
  });
  assert.equal(recipe.application.pluginId, 'application.test');
  assert.deepEqual(recipe.bindings.worker.config, {
    nested: {
      inherited: join(directory, 'inherited'),
      overridden: join(directory, 'new'),
    },
  });
  assert.equal(recipe.description, 'Assembly test');
  assert.deepEqual(recipe.budget, { modelCalls: 0, operations: 10 });
  assert.deepEqual(recipe.toJSON().policy, {
    id: 'policy.test',
    config: recipe.policyConfig,
    input: recipe.policyInput,
  });
  assert.deepEqual(recipe.toJSON().application, {
    plugin: 'application.test',
    config: { source: join(directory, 'source') },
  });
  assert.throws(() => {
    recipe.policyConfig.rounds = 5;
  }, TypeError);
  const restored = await Recipe.fromJSON(recipe.toJSON(), registry, {
    sourcePath: path,
    policy: recipe.policy,
  });
  assert.deepEqual(restored.toJSON(), recipe.toJSON());
});

test('Recipe rejects unknown bindings, invalid budgets, legacy fields and mismatched registered Policy IDs', async (t) => {
  const { registry, directory, recipe } = await recipeFixture(t);
  const path = join(directory, 'recipe.yaml');
  for (const invalid of [
    { ...recipe, bindings: { unknown: { plugin: 'worker' } } },
    { ...recipe, budget: { operations: 0.5 } },
    { ...recipe, budget: { cleanupReserveMs: 0 } },
    { ...recipe, policy: { ref: 'policy.test' } },
    { ...recipe, application: { ref: 'application.test' } },
    { ...recipe, reflection: { configFile: './reflection.yaml' } },
  ]) {
    await writeFile(path, stringify(invalid));
    await assert.rejects(Recipe.load(path, registry));
  }
  const policyPath = registry.policy('policy.test');
  registry.registerPolicy('policy.alias', policyPath);
  await writeFile(
    path,
    stringify({ ...recipe, policy: { id: 'policy.alias' } }),
  );
  await assert.rejects(
    Recipe.load(path, registry),
    /policy.alias.*policy.test|policy.test.*policy.alias/,
  );
});

test('Recipe selects one complete Reflection file and restores locked definitions after source files change', async (t) => {
  const { registry, directory, recipe: raw } = await recipeFixture(t);
  registry.registerOperation({
    id: 'reflection.test',
    contract: reflectionContract,
    configSchema: {
      type: 'object',
      properties: { mode: { type: 'string', default: 'safe' } },
      additionalProperties: false,
    },
    async create() {
      throw new Error('Loading created Reflection generator');
    },
  });
  const policyPath = registry.policy('policy.test');
  const policy = await readYaml(policyPath);
  object(policy.defaults).reflection = {
    configFile: './missing-default-reflection.yaml',
  };
  await writeFile(policyPath, stringify(policy));
  await writeFile(join(directory, 'inherited'), 'Inherited resource');
  await writeFile(join(directory, 'new'), 'Overridden resource');
  await writeFile(
    join(directory, 'goal.md'),
    'Improve the selected resources.',
  );
  const reflectionPath = join(directory, 'selected-reflection.yaml');
  await writeFile(
    reflectionPath,
    stringify({
      evidence: ['worker'],
      targets: { worker: { resources: ['nested'] } },
      goal: './goal.md',
      implementation: {
        contract: 'contract.reflection',
        ref: 'reflection.test',
        config: {},
      },
      budget: { modelCalls: 0 },
    }),
  );
  const recipePath = join(directory, 'recipe.yaml');
  await writeFile(
    recipePath,
    stringify({
      ...raw,
      reflection: { configFile: './selected-reflection.yaml' },
    }),
  );
  const recipe = await Recipe.load(recipePath, registry);
  assert.equal(recipe.reflection?.path, reflectionPath);
  assert.equal(recipe.reflection?.goal, 'Improve the selected resources.');
  assert.deepEqual(recipe.reflection?.implementation.config, { mode: 'safe' });
  assert.deepEqual(recipe.toJSON().reflection, { configFile: reflectionPath });
  await writeFile(policyPath, 'invalid changed Policy');
  await rm(reflectionPath);
  await rm(join(directory, 'goal.md'));
  const restored = await Recipe.fromJSON(recipe.toJSON(), registry, {
    sourcePath: recipePath,
    policy: recipe.policy,
    reflection: recipe.reflection,
  });
  assert.deepEqual(restored.toJSON(), recipe.toJSON());
  assert.deepEqual(restored.reflection, recipe.reflection);
  assert.notEqual(restored.reflection, recipe.reflection);
  await assert.rejects(Recipe.load(recipePath, registry));
});

test('Recipe rejects missing bindings and unavailable input roots during assembly', async (t) => {
  const { registry, directory, recipe: raw } = await recipeFixture(t);
  const policyPath = registry.policy('policy.test');
  const policy = await readYaml(policyPath);
  delete object(object(policy.defaults).bindings).worker;
  await writeFile(policyPath, stringify(policy));
  const path = join(directory, 'recipe.yaml');
  await writeFile(path, stringify({ ...raw, bindings: {} }));
  await assert.rejects(Recipe.load(path, registry), /Binding worker.*plugin/);
  await writeFile(
    path,
    stringify({
      ...raw,
      bindings: { worker: { plugin: 'worker' } },
      policy: { id: 'policy.test', input: { early: '${{ state.missing }}' } },
    }),
  );
  await assert.rejects(Recipe.load(path, registry), /state/);
});
