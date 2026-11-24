import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  agentContract,
  applicationContract,
  memoryContract,
  proposerContract,
  reflectionContract,
  type JsonObject,
  type PluginContract,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { configSchema as agentPiSchema } from '../../src/plugins/agent-pi/schema.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  lockDefinition,
  parseLockedMemory,
  parseLockedReflection,
  readResourceOrigins,
} from '../../src/runtime/manager/definition-lock.js';
import { object, string } from '../../src/shared/json.js';
import {
  resourcePath,
  assignPointer,
  pointerValue,
} from '../../src/runtime/learning/resources.js';

test('Reflection addresses escaped Schema keys while keeping snapshot paths portable', () => {
  const config: JsonObject = { 'prompt/sources': { 'my~file': 'before' } };
  const pointer = '/prompt~1sources/my~0file';
  assert.equal(pointerValue(config, pointer), 'before');
  assignPointer(config, pointer, 'after');
  assert.equal(object(config['prompt/sources'])['my~file'], 'after');
  assert.match(
    resourcePath('worker', pointer),
    /^bindings\/worker\/resources\/@[a-f0-9]{64}\/@[a-f0-9]{64}$/,
  );
  assert.throws(() => pointerValue(config, '/__proto__/x'), /Unsafe/);
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-learning-config-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const policyDir = join(root, 'policy'),
    recipeDir = join(root, 'recipe');
  await mkdir(policyDir);
  await mkdir(recipeDir);
  await mkdir(join(policyDir, 'guidance'));
  await mkdir(join(recipeDir, 'seed'));
  await writeFile(join(recipeDir, 'seed', 'notes.md'), 'seed');
  await writeFile(join(policyDir, 'inherited.md'), 'policy prompt');
  await writeFile(join(recipeDir, 'override.md'), 'recipe prompt');
  await writeFile(join(policyDir, 'goal.md'), 'policy goal');
  const file = { type: 'string', 'x-rsi-path': 'file' };
  function register(
    id: string,
    contract: PluginContract,
    properties: JsonObject = {},
  ) {
    registry.registerOperation({
      id,
      contract,
      configSchema: { type: 'object', properties, additionalProperties: false },
      async create() {
        throw new Error('Recipe loading must not create any instances');
      },
    });
  }
  register('application.test', applicationContract);
  register('proposer.test', proposerContract, {
    guidance: { type: 'string', 'x-rsi-path': 'directory' },
  });
  register('agent.test', agentContract);
  register('memory.test', memoryContract, {
    goalFile: file,
    resources: { type: 'object', properties: { a: file, b: file } },
  });
  registry.registerOperation({
    id: 'agent.pi',
    contract: agentContract,
    configSchema: agentPiSchema,
    async create() {
      throw new Error('unexpected activation');
    },
  });
  register('reflection.agent', reflectionContract, {
    agentRef: { type: 'string' },
    prompt: file,
  });
  register('reflection.test', reflectionContract);
  register('memory.agent', memoryContract, {
    agentRef: { type: 'string' },
    prompt: file,
  });
  const policy: JsonObject = {
    schemaVersion: 'rsi.policy/v1',
    id: 'learning',
    input_schema: { type: 'object' },
    output_schema: true,
    require: {
      proposer: { contract: proposerContract.id },
      backend: { contract: agentContract.id },
    },
    defaults: {
      bindings: {
        proposer: {
          plugin: 'proposer.test',
          config: { guidance: './guidance' },
        },
        backend: { plugin: 'agent.test' },
      },
    },
    steps: [
      {
        id: 'search',
        type: 'loop',
        maxIterations: 2,
        steps: [{ id: 'propose', type: 'invoke', use: 'proposer' }],
      },
    ],
    output: null,
  };
  const decl = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'probe',
    application: { plugin: 'application.test' },
    policy: { id: 'learning' },
  };
  const policyPath = join(policyDir, 'policy.yaml');
  registry.registerPolicy('learning', policyPath);
  async function load(overrides: JsonObject) {
    await writeFile(policyPath, JSON.stringify(policy));
    return Recipe.fromJSON({ ...decl, ...overrides }, registry, {
      sourcePath: join(recipeDir, 'recipe.yaml'),
    });
  }
  return { root, registry, policy, policyDir, recipeDir, load };
}

test('zero-configuration learning resolves real Agent schema defaults and all eligible Policy targets', async (t) => {
  const f = await fixture(t);
  const recipe = await f.load({});
  assert.equal(recipe.memory?.config.agentRef, '_learningAgent');
  assert.equal(recipe.reflection?.config.agentRef, '_learningAgent');
  assert.equal(recipe.bindings._learningAgent!.config.model, '${MODEL_NAME}');
  assert.equal(
    recipe.bindings._learningAgent!.config.base_url,
    '${MODEL_ENDPOINT}',
  );
  assert.equal(
    recipe.bindings._learningAgent!.config.api_key,
    '${MODEL_API_KEY}',
  );
  assert.deepEqual(recipe.memory?.trigger, { on: 'loop-iteration', every: 1 });
  assert.deepEqual(recipe.reflection?.targets, {
    proposer: { resources: ['/guidance'] },
  });
  assert.deepEqual(recipe.memory?.consumers, ['proposer', 'backend']);
  assert.equal(recipe.memory?.goalFile.endsWith('goal.md'), true);
  assert.equal(
    Object.hasOwn(object(recipe.toJSON().bindings), '_learningAgent'),
    false,
  );
});

test('a shared Reflection exclusion accepts Memory even when the Recipe disables it', async (t) => {
  const f = await fixture(t);
  const configFile = './reflection.yaml';
  object(f.policy.defaults).reflection = { configFile };
  const file = join(f.policyDir, configFile);
  await writeFile(
    file,
    JSON.stringify({ evidence: { excludeBindings: ['memory'] } }),
  );
  for (const memory of [true, false]) {
    const recipe = await f.load({ memory });
    assert.deepEqual(recipe.reflection?.observe.excludeBindings, ['memory']);
    assert.equal(
      recipe.reflection?.observe.bindings?.includes('memory'),
      memory,
    );
  }
  await writeFile(
    file,
    JSON.stringify({ evidence: { includeBindings: ['memory'] } }),
  );
  await assert.rejects(
    f.load({ memory: false }),
    /includeBindings: unknown binding memory/,
  );
  await writeFile(
    file,
    JSON.stringify({ evidence: { excludeBindings: ['typo'] } }),
  );
  await assert.rejects(
    f.load({ memory: false }),
    /excludeBindings: unknown binding typo/,
  );
});

test('Recipe toggles preserve or replace a Policy file and skip disabled configuration', async (t) => {
  const f = await fixture(t);
  object(f.policy.defaults).memory = { configFile: './memory.yaml' };
  object(f.policy.defaults).reflection = false;
  await writeFile(
    join(f.policyDir, 'memory.yaml'),
    JSON.stringify({
      goal: './goal.md',
      trigger: { on: 'after-step', step: 'propose', every: 2 },
      evidence: {
        view: 'training-summary',
        includeBindings: ['proposer'],
        excludeSteps: ['search'],
      },
      targets: { exclude: ['backend'] },
      implementation: { config: { agentRef: 'backend' } },
    }),
  );
  const inherited = await f.load({ memory: true });
  assert.equal(inherited.memory?.goal, 'policy goal');
  assert.equal(inherited.memory?.config.agentRef, 'backend');
  assert.deepEqual(inherited.memory?.consumers, ['proposer']);
  assert.deepEqual(inherited.memory?.trigger, {
    on: 'after-step',
    step: 'propose',
    every: 2,
  });
  assert.deepEqual(inherited.memory?.observe.excludeSteps, ['steps/search']);
  assert.equal(inherited.bindings._learningAgent, undefined);
  await writeFile(
    join(f.recipeDir, 'memory.yaml'),
    JSON.stringify({
      implementation: {
        ref: 'memory.test',
        config: { goalFile: './override.md' },
      },
      directory: './missing',
    }),
  );
  const override = await f.load({
    memory: { configFile: './memory.yaml' },
    reflection: true,
  });
  assert.equal(override.memory?.seed?.directory, join(f.recipeDir, 'missing'));
  assert.equal(
    override.memory?.config.goalFile,
    join(f.recipeDir, 'override.md'),
  );
  assert.deepEqual(override.memory?.trigger, {
    on: 'loop-iteration',
    every: 1,
  });
  assert.equal(override.reflection?.config.agentRef, '_learningAgent');
  await rm(join(f.policyDir, 'memory.yaml'));
  assert.equal((await f.load({ memory: false })).memory, undefined);
});

test('definition locks preserve learning configurations, source directories, seed artifacts and Agent settings across recovery', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.recipeDir, 'memory.yaml'),
    JSON.stringify({ directory: './seed' }),
  );
  const recipe = await f.load({ memory: { configFile: './memory.yaml' } });
  const store = new FileArtifacts(join(f.root, 'artifacts'));
  const dir = join(f.root, 'lock');
  const locked = await lockDefinition(recipe, f.registry, store, dir);
  const memory = parseLockedMemory(locked.memory!),
    reflection = parseLockedReflection(locked.reflection!);
  assert.equal(
    readResourceOrigins(locked)._memory!['/directory'],
    join(f.recipeDir, 'seed'),
  );
  assert.equal(
    object(locked.plugins)['agent.pi'],
    f.registry.identity('agent.pi'),
  );
  const tree = object(await store.readJson(memory.seedArtifactRef!));
  assert.ok(
    Array.isArray(tree.files) &&
      tree.files.some((x) => object(x).path === 'notes.md'),
  );
  await rm(join(f.recipeDir, 'memory.yaml'));
  await rm(join(f.recipeDir, 'seed'), { recursive: true });
  const recovered = await Recipe.fromJSON(locked.recipe, f.registry, {
    sourcePath: recipe.sourcePath,
    policy: recipe.policy,
    lockedLearning: true,
    memory,
    reflection,
  });
  const retried = await lockDefinition(
    recovered,
    f.registry,
    store,
    dir,
    { ref: 'retry-probe' },
    locked,
  );
  assert.deepEqual(retried.memory, locked.memory);
  assert.equal(
    recovered.bindings._learningAgent!.config.model,
    '${MODEL_NAME}',
  );
  assert.equal(await readFile(memory.goalFile, 'utf8'), memory.goal);
  const empty = await f.load({});
  const emptyLock = await lockDefinition(
    empty,
    f.registry,
    store,
    join(f.root, 'empty-lock'),
  );
  assert.deepEqual(
    await store.readJson(string(object(emptyLock.memory).seedArtifactRef)),
    { kind: 'file-tree', files: [] },
  );
});

test('invalid learning declarations, resources, filters and parallel triggers reject before execution', async (t) => {
  const f = await fixture(t);
  const steps = f.policy.steps;
  assert.ok(Array.isArray(steps));
  steps.push({
    id: 'fanout',
    type: 'foreach',
    foreach: [1, 2],
    as: 'item',
    key: '${{ item }}',
    concurrency: 2,
    steps: [{ id: 'inside', type: 'invoke', use: 'proposer' }],
  });
  for (const [kind, configuration, reason] of [
    [
      'memory',
      { implementation: { config: { agentRef: 'proposer' } } },
      /agentRef/,
    ],
    [
      'memory',
      { trigger: { on: 'after-step', step: 'inside' } },
      /parallel foreach/,
    ],
    [
      'memory',
      { trigger: { on: 'loop-end', step: 'search' } },
      /step|required/,
    ],
    ['memory', { trigger: { every: 0 } }, /every/],
    [
      'memory',
      { evidence: { excludeSteps: ['absent'] } },
      /Unknown learning step/,
    ],
    ['memory', { targets: { include: ['absent'] } }, /unknown binding/],
    ['memory', { directory: './override.md' }, /directory/],
    ['memory', { directory: './.rsi/private' }, /Protected/],
    [
      'reflection',
      { targets: { exclude: { proposer: ['absent'] } } },
      /not declared/,
    ],
    [
      'reflection',
      { targets: { include: { absent: ['*'] } } },
      /unknown binding/,
    ],
    ['reflection', { trigger: { afterPolicy: true } }, /additional properties/],
  ] as const) {
    await writeFile(
      join(f.recipeDir, 'invalid.yaml'),
      JSON.stringify(configuration),
    );
    await assert.rejects(
      f.load({ [kind]: { configFile: './invalid.yaml' } }),
      reason,
    );
  }
  await assert.rejects(f.load({ memory: { enabled: false } }), /recipe/);
});
