import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { applicationContract } from '../../src/contracts/plugin-types/application.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { reflectionContract } from '../../src/contracts/plugin-types/reflection.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { readYaml } from '../../src/runtime/loaders/yaml.js';
import { object } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';
import {
  iterativeProposerContract,
  type JsonSchema,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { defineContract } from '../../src/contracts/contract.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Binding } from '../../src/runtime/loaders/binding.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { agentbundleDefinition } from '../../src/plugins/application-agentbundle/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { proposerDefinition } from '../../src/plugins/proposer-agent/index.js';
import { memoryDefinition } from '../../src/plugins/memory-agent/index.js';
import { gymDefinition } from '../../src/plugins/evaluator-gym/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';

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
        memory: false,
        reflection: false,
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

test('GEPA example loads through built-in registration with recipe-relative resources', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  assert.ok(registry.catalog().plugins.includes('proposer.pareto-evolution'));
  assert.ok(registry.catalog().policies.includes('policy.gepa'));
  assert.deepEqual(
    registry.get('proposer.pareto-evolution').contract,
    iterativeProposerContract,
  );
  const directory = resolve('examples/harness/dsh-gepa');
  const recipe = await Recipe.load(join(directory, 'recipe.yaml'), registry);
  assert.equal(recipe.policy.id, 'policy.gepa');
  assert.deepEqual(recipe.policy.toJSON().state, { evolution: {} });
  assert.equal(
    recipe.bindings.evolutionProposer!.pluginId,
    'proposer.pareto-evolution',
  );
  const dataset = object(recipe.policyConfig.dataset);
  const populationConfig = recipe.bindings.evolutionProposer!.config;
  assert.equal(populationConfig.maxRounds, 15);
  assert.equal(populationConfig.maxRollouts, 120);
  assert.equal(populationConfig.minibatchSize, 1);
  assert.equal(populationConfig.feedbackSampling, 'coverage-first');
  assert.equal(populationConfig.paretoSize, 5);
  assert.equal(populationConfig.crossoverEvery, 0);
  assert.equal((dataset.trainTaskIds as string[]).length, 10);
  assert.equal((dataset.validationTaskIds as string[]).length, 5);
  assert.equal(recipe.bindings.proposer!.pluginId, 'proposer.agent');
  assert.equal(recipe.bindings.proposer!.config.agentRef, 'agent');
  assert.equal(
    recipe.bindings.proposer!.config.evidenceView,
    'training-summary',
  );
  assert.equal(recipe.memory?.evidenceView, 'training');
  assert.equal(recipe.memory?.config.agentRef, 'agent');
  assert.ok(recipe.memory?.consumers.includes('proposer'));
  assert.equal(recipe.reflection?.evidenceView, 'training');
  assert.equal(recipe.reflection?.config.agentRef, 'agent');
  assert.deepEqual(recipe.reflection?.targets, {
    proposer: { resources: ['/prompt'] },
  });
  assert.equal(recipe.bindings.proposer!.config.maxModelCalls, undefined);
  assert.equal(recipe.bindings.agent!.config.maxTokens, undefined);
  for (const service of Object.values(
    object(recipe.bindings.evaluator!.config.services),
  ))
    assert.equal(object(service).maxTokens, undefined);
  assert.deepEqual(recipe.budget, { elapsedWallMs: 86400000 });
  assert.equal(recipe.bindings.proposer!.config.maxEvidenceBytes, undefined);
  const raw = await readYaml(join(directory, 'recipe.yaml'));
  registry.registerOperation({
    id: 'proposer.custom-gepa',
    contract: proposerDefinition.contract,
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { template: { type: 'string', 'x-rsi-path': 'file' } },
    },
    async create() {
      throw new Error('Recipe loading must not instantiate the proposer');
    },
  });
  const customRecipe = {
    ...raw,
    bindings: {
      ...object(raw.bindings),
      proposer: {
        plugin: 'proposer.custom-gepa',
        config: { template: recipe.bindings.proposer!.config.prompt },
      },
    },
  };
  const sourcePath = join(directory, 'recipe.yaml');
  const custom = await Recipe.fromJSON(customRecipe, registry, { sourcePath });
  assert.deepEqual(custom.reflection?.targets, {
    proposer: { resources: ['/template'] },
  });
  for (const field of [
    'evaluatorBinding',
    'reflectorBinding',
    'proposerBinding',
    'reflectionMaxModelCalls',
    'maxEvidenceBytes',
    'dataset',
    'feedbackTaskIds',
    'selectionTaskIds',
  ]) {
    assert.equal(Object.hasOwn(populationConfig, field), false);
    const settings = { ...populationConfig, [field]: 'duplicate-route' };
    await assert.rejects(
      Recipe.fromJSON(
        {
          ...raw,
          bindings: {
            ...object(raw.bindings),
            evolutionProposer: {
              plugin: 'proposer.pareto-evolution',
              config: settings,
            },
          },
        },
        registry,
        { sourcePath: join(directory, 'recipe.yaml') },
      ),
      /additional properties/,
    );
    assert.throws(
      () =>
        validate(
          iterativeProposerContract.input_schema,
          {
            action: 'initialize',
            parent: 'initial-candidate',
            feedbackTaskIds: dataset.trainTaskIds,
            selectionTaskIds: dataset.validationTaskIds,
            settings,
          },
          'iterative proposer input',
        ),
      /additional properties/,
    );
  }
  await assert.rejects(
    Recipe.fromJSON(
      {
        ...raw,
        policy: {
          ...object(raw.policy),
          config: { ...recipe.policyConfig, ...populationConfig },
        },
      },
      registry,
      { sourcePath: join(directory, 'recipe.yaml') },
    ),
    /additional properties/,
  );
  await assert.rejects(
    Recipe.fromJSON(
      {
        ...raw,
        policy: {
          ...object(raw.policy),
          config: { dataset: { ...dataset, trainTaskIds: [] } },
        },
      },
      registry,
      { sourcePath: join(directory, 'recipe.yaml') },
    ),
    /fewer than 1 items/,
  );
  assert.equal(
    object(recipe.application.config.target).schema,
    join(directory, 'target.yaml'),
  );
  assert.equal(
    object(recipe.application.config.baseline).directory,
    join(directory, 'baseline'),
  );
  await readYaml(join(directory, 'target.yaml'));
  await readYaml(join(directory, 'baseline/bundle.yaml'));
});

test('Harness虏 uses the generic Reflection goal and limits evolution to its intended consumers and Proposer resources', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  const recipe = await Recipe.load(
    'examples/harness/dsh-harness2/recipe.yaml',
    registry,
  );
  assert.equal(recipe.memory?.evidenceView, 'execution');
  assert.ok(recipe.memory?.consumers.includes('invariantProposer'));
  assert.ok(!recipe.memory.consumers.includes('selector'));
  assert.equal(recipe.reflection?.evidenceView, 'execution');
  assert.equal(
    recipe.reflection?.goalFile,
    resolve('src/plugins/reflection-agent/goals/generic/prompt.md'),
  );
  assert.deepEqual(recipe.reflection?.targets, {
    invariantProposer: { resources: ['/prompt', '/skills/0'] },
    domainProposer: { resources: ['/prompt', '/skills/0'] },
  });
});

test('bundled Recipes preserve time budgets without injecting call or token limits', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  for (const name of ['dsh-harness2', 'dsh-wikiskill']) {
    const sourcePath = resolve(`examples/harness/${name}/recipe.yaml`);
    const raw = object(await readYaml(sourcePath));
    const overrides = object(raw.bindings);
    const agentConfig = object(object(overrides.agent).config);
    const evaluatorServices = object(
      object(object(overrides.evaluator).config).services,
    );
    const configured = await Recipe.fromJSON(raw, registry, { sourcePath });
    assert.deepEqual(configured.budget, {
      elapsedWallMs: name === 'dsh-harness2' ? 259200000 : 172800000,
    });
    assert.deepEqual(
      configured.reflection?.budget,
      name === 'dsh-harness2' ? { elapsedWallMs: 3600000 } : {},
    );
    assert.equal(configured.bindings.agent!.config.timeoutMs, 1800000);
    assert.equal(configured.bindings.agent!.config.executionTimeoutMs, 3600000);
    assert.equal(configured.bindings.agent!.config.retries, 3);
    assert.equal(configured.bindings.agent!.config.retryBaseDelayMs, 2000);
    assert.equal(
      object(configured.bindings.evaluator!.config.run ?? {}).timeoutSeconds,
      name === 'dsh-harness2' ? 4500 : 3600,
    );
    delete agentConfig.timeoutMs;
    delete agentConfig.executionTimeoutMs;
    const recipe = await Recipe.fromJSON(raw, registry, { sourcePath });
    assert.equal(recipe.budget.modelCalls, undefined);
    assert.equal(recipe.bindings.agent!.config.maxTokens, undefined);
    for (const service of Object.values(
      object(recipe.bindings.evaluator!.config.services),
    ))
      assert.equal(object(service).maxTokens, undefined);
    assert.equal(recipe.bindings.agent!.config.timeoutMs, undefined);
    assert.equal(recipe.bindings.agent!.config.executionTimeoutMs, undefined);
    assert.equal(recipe.reflection?.budget.modelCalls, undefined);
    assert.equal(recipe.reflection?.config.maxModelCalls, undefined);
    const editors = Object.entries(recipe.bindings).filter(([, binding]) =>
      ['proposer.agent', 'memory.agent', 'selector.artifact'].includes(
        binding.pluginId,
      ),
    );
    for (const [bindingName, binding] of editors) {
      assert.equal(binding.config.maxModelCalls, undefined);
      const original = overrides[bindingName];
      const declaration = object(original ?? {});
      overrides[bindingName] = {
        ...declaration,
        config: { ...object(declaration.config ?? {}), maxModelCalls: 2 },
      };
      await assert.rejects(
        Recipe.fromJSON(raw, registry, { sourcePath }),
        /additional properties|maxModelCalls/,
      );
      if (original === undefined) delete overrides[bindingName];
      else overrides[bindingName] = original;
    }
    object(raw.budget).modelCalls = 17;
    agentConfig.maxTokens = 32768;
    object(evaluatorServices.default).maxTokens = 65536;
    agentConfig.timeoutMs = 1800000;
    agentConfig.executionTimeoutMs = 3600000;
    const limited = await Recipe.fromJSON(raw, registry, { sourcePath });
    assert.equal(limited.budget.modelCalls, 17);
    assert.equal(limited.bindings.agent!.config.maxTokens, 32768);
    assert.equal(
      object(object(limited.bindings.evaluator!.config.services).default)
        .maxTokens,
      65536,
    );
    assert.equal(limited.bindings.agent!.config.timeoutMs, 1800000);
    assert.equal(limited.bindings.agent!.config.executionTimeoutMs, 3600000);
  }
});

test('Gym GAIA Recipe separates train_full search from holdout promotion', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerOperation(agentbundleDefinition);
  registry.registerOperation(piDefinition);
  registry.registerOperation(proposerDefinition);
  registry.registerOperation(memoryDefinition);
  registry.registerOperation(reflectionDefinition);
  registry.registerOperation(metricSelectorDefinition);
  registry.registerOperation(gymDefinition);
  registry.registerPolicy(
    'policy.gym-rsi',
    resolve('src/policies/gym-rsi/policy.yaml'),
  );
  const recipe = await Recipe.load(
    resolve('examples/harness/dsh-gym-gaia/recipe.yaml'),
    registry,
  );
  const evaluator = recipe.bindings.evaluator!;
  const promotion = recipe.bindings.promotion!;
  assert.equal(recipe.policy.id, 'policy.gym-rsi');
  assert.equal(recipe.policyConfig.maxRounds, 1);
  assert.equal(recipe.reflection, undefined);
  assert.equal(evaluator.pluginId, 'evaluator.gym');
  assert.equal(promotion.pluginId, 'evaluator.gym');
  assert.equal(evaluator.config.mode, 'evaluate');
  assert.equal(promotion.config.mode, 'promote');
  assert.equal(object(evaluator.config.requestDefaults).split, 'train_full');
  assert.equal(Object.hasOwn(recipe.policyConfig, 'release'), false);
  const dataset = object(recipe.policyConfig.dataset);
  assert.equal(Object.hasOwn(dataset, 'testTaskIds'), false);
  assert.equal(
    new Set([
      ...(dataset.trainTaskIds as string[]),
      ...(dataset.validationTaskIds as string[]),
    ]).size,
    (dataset.trainTaskIds as string[]).length +
      (dataset.validationTaskIds as string[]).length,
  );
  assert.equal(
    object(promotion.config.promotionDefaults).benchmark,
    'gaia_text_validation',
  );
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
    { ...recipe, reflection: { enabled: true } },
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

test('Recipe merges Reflection overrides and restores locked definitions after source files change', async (t) => {
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
  object(policy.defaults).reflection = { configFile: './unused-default.yaml' };
  await writeFile(
    join(directory, 'reflection.yaml'),
    stringify({
      trigger: { on: 'experiment-end' },
      evidence: { includeBindings: ['worker'] },
      targets: { include: { worker: ['nested'] } },
      implementation: { ref: 'reflection.test' },
      goal: './goal.md',
      budget: { modelCalls: 0 },
    }),
  );
  await writeFile(policyPath, stringify(policy));
  await writeFile(join(directory, 'inherited'), 'Inherited resource');
  await writeFile(join(directory, 'new'), 'Overridden resource');
  await writeFile(
    join(directory, 'goal.md'),
    'Improve the selected resources.',
  );
  const recipePath = join(directory, 'recipe.yaml');
  await writeFile(
    recipePath,
    stringify({
      ...raw,
      reflection: { configFile: './reflection.yaml' },
    }),
  );
  const recipe = await Recipe.load(recipePath, registry);
  assert.deepEqual(recipe.reflection?.trigger, {
    on: 'experiment-end',
    every: 1,
  });
  assert.equal(recipe.reflection?.goal, 'Improve the selected resources.');
  assert.deepEqual(recipe.reflection?.config, { mode: 'safe' });
  assert.equal(
    object(recipe.toJSON().reflection).configFile,
    './reflection.yaml',
  );
  await writeFile(policyPath, 'invalid changed Policy');
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
