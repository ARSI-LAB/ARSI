import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  parseCoveringRoots,
  pointerValue,
  resolveCoveringRoots,
} from '../../src/runtime/evolution/resources.js';

const proposerTargets = { include: { proposer: ['instructions'] } };
const reflectionFile = { configFile: './reflection.yaml' };

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
async function fixture(t: TestContext, agents = ['backend']) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-evolution-config-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const policyDir = join(root, 'policy');
  // Relative Memory seeds in the Recipe are writable destinations and require an unlinked path.
  const recipeDir = join(await realpath(root), 'recipe');
  await mkdir(policyDir);
  await mkdir(recipeDir);
  await mkdir(join(policyDir, 'instructions'));
  await mkdir(join(recipeDir, 'seed'));
  await writeFile(join(recipeDir, 'seed', 'notes.md'), 'seed');
  await writeFile(join(policyDir, 'inherited.md'), 'policy prompt');
  await writeFile(join(recipeDir, 'override.md'), 'recipe prompt');
  await writeFile(join(policyDir, 'goal.md'), 'policy goal');
  await writeFile(
    join(policyDir, 'reflection.yaml'),
    JSON.stringify({ targets: proposerTargets }),
  );
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
    instructions: { type: 'string', 'x-rsi-path': 'directory' },
    prompt: file,
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
    id: 'evolution',
    input_schema: { type: 'object' },
    output_schema: true,
    require: {
      proposer: { contract: proposerContract.id },
      ...Object.fromEntries(
        agents.map((name) => [name, { contract: agentContract.id }]),
      ),
    },
    defaults: {
      bindings: {
        proposer: {
          plugin: 'proposer.test',
          config: { instructions: './instructions', prompt: './inherited.md' },
        },
        ...Object.fromEntries(
          agents.map((name) => [name, { plugin: 'agent.test' }]),
        ),
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
    policy: { id: 'evolution' },
  };
  const policyPath = join(policyDir, 'policy.yaml');
  registry.registerPolicy('evolution', policyPath);
  async function load(overrides: JsonObject) {
    await writeFile(policyPath, JSON.stringify(policy));
    return Recipe.fromJSON({ ...decl, ...overrides }, registry, {
      sourcePath: join(recipeDir, 'recipe.yaml'),
    });
  }
  return { root, registry, policy, policyDir, recipeDir, load };
}

test('overlapping Reflection members must agree on the linked route to their source', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  await symlink(
    f.policyDir,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const parent = {
    binding: 'writer',
    pointer: '/instructions',
    kind: 'directory',
    path: f.policyDir,
  } as const;
  const member = {
    binding: 'reader',
    pointer: '/prompt',
    kind: 'file',
    path: join(alias, 'inherited.md'),
  } as const;
  for (const entries of [
    [parent, member],
    [member, parent],
  ])
    await assert.rejects(
      resolveCoveringRoots(entries),
      /Inconsistent Reflection source aliases/,
    );
});

test('shared roots have a separate namespace from a binding named shared and keep previously recorded artifact paths', async (t) => {
  const f = await fixture(t);
  const owners = ['reader', 'writer'].map((binding) => ({
    binding,
    pointer: '/prompt',
    kind: 'file' as const,
    path: join(f.policyDir, 'inherited.md'),
  }));
  const [shared] = await resolveCoveringRoots(owners);
  assert.ok(shared);
  assert.match(shared.artifactPath, /^resources\/_shared\//);
  const name = shared.artifactPath.split('/').at(-1)!;
  const previous = { ...shared, artifactPath: 'resources/shared/' + name };
  assert.deepEqual(parseCoveringRoots([previous]), [previous]);
  const separate = {
    binding: 'shared',
    pointer: '/' + name,
    kind: 'file' as const,
    path: join(f.recipeDir, 'override.md'),
  };
  const roots = await resolveCoveringRoots([separate, ...owners.reverse()]);
  assert.deepEqual(
    roots.map((root) => root.artifactPath).sort(),
    [shared.artifactPath, previous.artifactPath].sort(),
  );
});

test('a custom Policy enables Memory by default and only enables Reflection with a target declaration', async (t) => {
  const f = await fixture(t);
  const unconfigured = await f.load({});
  assert.deepEqual(unconfigured.disabledEvolution, ['reflection']);
  assert.equal(unconfigured.reflection, undefined);
  assert.equal(unconfigured.memory?.config.agentRef, 'backend');
  object(f.policy.defaults).reflection = reflectionFile;
  const recipe = await f.load({});
  assert.equal(recipe.memory?.evidenceView, 'training');
  assert.equal(recipe.reflection?.evidenceView, 'training');
  assert.equal(recipe.memory?.config.agentRef, 'backend');
  assert.equal(recipe.reflection?.config.agentRef, 'backend');
  assert.equal(recipe.bindings._evolutionAgent, undefined);
  assert.deepEqual(recipe.memory?.trigger, { on: 'loop-iteration', every: 1 });
  assert.deepEqual(recipe.reflection?.targets, {
    proposer: { resources: ['/instructions'] },
  });
  assert.deepEqual(recipe.memory?.consumers, ['proposer', 'backend']);
  assert.equal(recipe.memory?.goalFile.endsWith('goal.md'), true);
});

for (const agents of [[], ['first', 'second']]) {
  test(`evolution synthesizes one Pi binding for ${agents.length} declared Agents`, async (t) => {
    const f = await fixture(t, agents);
    const disabled = await f.load({ memory: false });
    assert.equal(disabled.reflection, undefined);
    assert.equal(disabled.bindings._evolutionAgent, undefined);
    object(f.policy.defaults).reflection = reflectionFile;
    const recipe = await f.load({});
    assert.equal(recipe.memory?.config.agentRef, '_evolutionAgent');
    assert.equal(recipe.reflection?.config.agentRef, '_evolutionAgent');
    const agent = recipe.bindings._evolutionAgent;
    assert.equal(agent.pluginId, 'agent.pi');
    assert.equal(agent.config.model, '${MODEL_NAME}');
    assert.equal(agent.config.base_url, '${MODEL_ENDPOINT}');
    assert.equal(agent.config.api_key, '${MODEL_API_KEY}');
    assert.equal(
      Object.hasOwn(object(recipe.toJSON().bindings), '_evolutionAgent'),
      false,
    );
  });
}

test('Recipe Reflection declarations disable, inherit or replace the Policy target file', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.recipeDir, 'reflection.yaml'),
    JSON.stringify({ targets: { include: { proposer: ['prompt'] } } }),
  );
  const defaults = object(f.policy.defaults);
  for (const fallback of [undefined, false, true, reflectionFile]) {
    if (fallback === undefined) delete defaults.reflection;
    else defaults.reflection = fallback;
    for (const override of [undefined, false, true, reflectionFile]) {
      const loaded = f.load(
        override === undefined ? {} : { reflection: override },
      );
      if (override === false || (override === undefined && !fallback)) {
        assert.equal((await loaded).reflection, undefined);
      } else if (override === reflectionFile) {
        assert.deepEqual((await loaded).reflection?.targets, {
          proposer: { resources: ['/prompt'] },
        });
      } else if (fallback === reflectionFile) {
        assert.deepEqual((await loaded).reflection?.targets, {
          proposer: { resources: ['/instructions'] },
        });
      } else {
        await assert.rejects(
          loaded,
          /reflection requires a configFile declaring targets\.include/,
        );
      }
    }
  }
});

test('Reflection requires a nonempty include and a local resource after exclusions', async (t) => {
  const f = await fixture(t);
  const file = join(f.recipeDir, reflectionFile.configFile);
  for (const [declaration, reason] of [
    [{}, /required property 'targets'/],
    [{ targets: {} }, /required property 'include'/],
    [
      { targets: { exclude: { proposer: '*' } } },
      /required property 'include'/,
    ],
    [{ targets: { include: {} } }, /fewer than 1 properties/],
    [{ targets: { include: [] } }, /must be object/],
    [{ targets: { include: null } }, /must be object/],
    [
      { targets: { include: { proposer: null } } },
      /targets\/include\/proposer/,
    ],
    [{ targets: { include: { proposer: [] } } }, /fewer than 1 items/],
    [
      { targets: { include: { proposer: ['*', 'prompt'] } } },
      /targets\/include\/proposer/,
    ],
    [
      {
        targets: {
          include: { proposer: ['instructions'] },
          exclude: { proposer: ['instructions'] },
        },
      },
      /must select at least one editable resource/,
    ],
    [
      { targets: { include: { proposer: '*' }, exclude: { proposer: ['*'] } } },
      /must select at least one editable resource/,
    ],
    [
      { targets: { include: { proposer: '*' }, exclude: { unknown: '*' } } },
      /exclude: unknown binding unknown/,
    ],
    [
      { targets: { include: { backend: ['*'], proposer: ['instructions'] } } },
      /backend: no local x-rsi-path resources/,
    ],
  ] as const) {
    await writeFile(file, JSON.stringify(declaration));
    await assert.rejects(f.load({ reflection: reflectionFile }), reason);
  }
});

test('Reflection rejects explicitly included URLs and binding wildcards only select local paths', async (t) => {
  const f = await fixture(t);
  const bindings = object(object(f.policy.defaults).bindings);
  const proposer = object(object(bindings.proposer).config);
  proposer.prompt = 'https://example.invalid/prompt.md';
  const file = join(f.recipeDir, reflectionFile.configFile);
  for (const selection of ['*', ['*']]) {
    await writeFile(
      file,
      JSON.stringify({ targets: { include: { proposer: selection } } }),
    );
    assert.deepEqual(
      (await f.load({ reflection: reflectionFile })).reflection?.targets,
      {
        proposer: { resources: ['/instructions'] },
      },
    );
  }
  await writeFile(
    file,
    JSON.stringify({
      targets: {
        include: { proposer: ['prompt', 'instructions'] },
        exclude: { proposer: ['prompt'] },
      },
    }),
  );
  await assert.rejects(
    f.load({ reflection: reflectionFile }),
    /proposer\/prompt: cannot edit a remote URL/,
  );
  proposer.instructions = 'https://example.invalid/instructions';
  await writeFile(
    file,
    JSON.stringify({ targets: { include: { proposer: '*' } } }),
  );
  await assert.rejects(
    f.load({ reflection: reflectionFile }),
    /proposer: no local x-rsi-path resources/,
  );
});

test('explicit evolution Agent references select among multiple declared Agents', async (t) => {
  const f = await fixture(t, ['first', 'second']);
  for (const [kind, agentRef] of [
    ['memory', 'first'],
    ['reflection', 'second'],
  ]) {
    await writeFile(
      join(f.recipeDir, kind + '.yaml'),
      JSON.stringify({
        implementation: { config: { agentRef } },
        ...(kind === 'reflection' ? { targets: proposerTargets } : {}),
      }),
    );
  }
  const recipe = await f.load({
    memory: { configFile: './memory.yaml' },
    reflection: { configFile: './reflection.yaml' },
  });
  assert.equal(recipe.memory?.config.agentRef, 'first');
  assert.equal(recipe.reflection?.config.agentRef, 'second');
  assert.equal(recipe.bindings._evolutionAgent, undefined);
});

test('a shared Reflection exclusion accepts Memory even when the Recipe disables it', async (t) => {
  const f = await fixture(t);
  const configFile = './reflection.yaml';
  object(f.policy.defaults).reflection = { configFile };
  const file = join(f.policyDir, configFile);
  await writeFile(
    file,
    JSON.stringify({
      targets: proposerTargets,
      evidence: { excludeBindings: ['memory'] },
    }),
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
    JSON.stringify({
      targets: proposerTargets,
      evidence: { includeBindings: ['memory'] },
    }),
  );
  await assert.rejects(
    f.load({ memory: false }),
    /includeBindings: unknown binding memory/,
  );
  await writeFile(
    file,
    JSON.stringify({
      targets: proposerTargets,
      evidence: { excludeBindings: ['typo'] },
    }),
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
  assert.equal(inherited.bindings._evolutionAgent, undefined);
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
  assert.equal(override.memory?.config.agentRef, undefined);
  assert.equal(override.reflection, undefined);
  await rm(join(f.policyDir, 'memory.yaml'));
  assert.equal((await f.load({ memory: false })).memory, undefined);
});

test('definition locks preserve evolution configurations, source directories, seed artifacts and Agent settings across recovery', async (t) => {
  const f = await fixture(t, []);
  object(f.policy.defaults).reflection = reflectionFile;
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
  // Earlier definition locks can contain an empty target set.
  assert.deepEqual(
    parseLockedReflection({ ...object(locked.reflection!), targets: {} })
      .targets,
    {},
  );
  assert.equal(memory.evidenceView, 'training');
  assert.equal(reflection.evidenceView, 'training');
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
    lockedEvolution: true,
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
  assert.equal(recovered.reflection?.evidenceView, 'training');
  assert.deepEqual(retried.reflection, locked.reflection);
  assert.equal(
    recovered.bindings._evolutionAgent!.config.model,
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

test('invalid evolution declarations, resources, filters and parallel triggers reject before execution', async (t) => {
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
      /Unknown runtime evolution step/,
    ],
    ['memory', { targets: { include: ['absent'] } }, /unknown binding/],
    ['memory', { directory: './override.md' }, /directory/],
    ['memory', { directory: './.rsi/private' }, /Protected/],
    [
      'reflection',
      { targets: { ...proposerTargets, exclude: { proposer: ['absent'] } } },
      /not declared/,
    ],
    [
      'reflection',
      { targets: { include: { absent: ['*'] } } },
      /unknown binding/,
    ],
    [
      'reflection',
      { targets: proposerTargets, trigger: { afterPolicy: true } },
      /additional properties/,
    ],
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
