import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type {
  Binding,
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import {
  agentContract,
  applicationContract,
  proposerContract,
  reflectionContract,
} from '../../src/contracts/plugin-types/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { validateReflection } from '../../src/runtime/revisions/validation.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { createRuntime, validateRecipe } from '../../src/runtime/context.js';
import { object } from '../../src/shared/json.js';
import { parseLockedReflection } from '../../src/runtime/manager/definition-lock.js';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-reflection-config-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const generator: OperationDefinition = {
    id: 'reflection.custom',
    contract: reflectionContract,
    configSchema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', 'x-rsi-path': 'file' },
        mode: { enum: ['conservative'], default: 'conservative' },
      },
      required: ['instructions'],
      additionalProperties: false,
    },
    async create() {
      return {
        async execute() {
          return { status: 'no-change', proposal: null, reason: 'No change' };
        },
        async dispose() {},
      };
    },
  };
  const target: OperationDefinition = {
    ...generator,
    id: 'proposer.test',
    contract: proposerContract,
    configSchema: {
      type: 'object',
      properties: {
        guidance: { type: 'string', 'x-rsi-path': 'directory' },
        prompt: { type: 'string', 'x-rsi-path': 'file' },
        label: { type: 'string' },
      },
      additionalProperties: false,
    },
  };
  registry.registerOperation(generator);
  registry.registerOperation(target);
  registry.registerOperation(reflectionDefinition);
  registry.registerOperation({
    ...generator,
    id: 'agent.test',
    contract: agentContract,
  });
  await mkdir(join(root, 'guidance'));
  await writeFile(join(root, 'prompt.md'), 'Base prompt');
  const bindings: Record<string, Binding> = {
    proposer: {
      plugin: target.id,
      config: {
        guidance: join(root, 'guidance'),
        prompt: join(root, 'prompt.md'),
        label: 'plain string',
      },
    },
    other: { plugin: target.id, config: { prompt: join(root, 'prompt.md') } },
    agent: { plugin: 'agent.test', config: {} },
    'agent.default': { plugin: 'agent.test', config: {} },
  };
  const definition: JsonObject = {
    evidence: ['proposer'],
    targets: {
      proposer: { resources: ['guidance'] },
      other: { resources: ['prompt'] },
    },
    goal: './goal.md',
    implementation: {
      contract: reflectionContract.id,
      ref: generator.id,
      config: { instructions: './prompt.md' },
    },
  };
  await writeFile(join(root, 'goal.md'), 'Improve reusable guidance');
  await writeFile(join(root, 'other-goal.md'), 'Another goal');
  const path = join(root, 'reflection.yaml');
  async function load(value: JsonObject = definition) {
    await writeFile(path, stringify(value));
    return validateReflection(
      path,
      bindings,
      (id) => registry.get(id),
      (id) => registry.contract(id),
    );
  }
  return { root, path, registry, bindings, definition, load };
}
test('Reflection parses one complete config, preserving per-target permissions and implementation defaults', async (t) => {
  const { root, path, definition, load } = await fixture(t);
  const parsed = await load();
  assert.equal(parsed.path, path);
  assert.deepEqual(parsed.targets, {
    proposer: { resources: ['guidance'] },
    other: { resources: ['prompt'] },
  });
  assert.deepEqual(parsed.budget, {});
  assert.deepEqual(parsed.implementation.config, {
    instructions: join(root, 'prompt.md'),
    mode: 'conservative',
  });
  assert.equal(Object.hasOwn(parsed.implementation.config, 'agentRef'), false);
  assert.deepEqual(definition.implementation, {
    contract: reflectionContract.id,
    ref: 'reflection.custom',
    config: { instructions: './prompt.md' },
  });
  assert.notEqual(
    (await load({ ...definition, goal: './other-goal.md' })).digest,
    parsed.digest,
  );
});
test('Reflection budgets apply only when explicitly configured', async (t) => {
  const { definition, load } = await fixture(t);
  const defaults: JsonObject[] = [{}, { timeoutSeconds: 600 }];
  for (const budget of defaults) {
    const parsed = await load({ ...definition, budget });
    assert.equal(parsed.budget.modelCalls, undefined);
    assert.equal(
      parsed.budget.elapsedWallMs,
      'timeoutSeconds' in budget ? 600000 : undefined,
    );
  }
  for (const modelCalls of [0, 2, 50, 80])
    assert.equal(
      (await load({ ...definition, budget: { modelCalls } })).budget.modelCalls,
      modelCalls,
    );
  const invalid: JsonObject[] = [
    { modelCalls: -1 },
    { modelCalls: null },
    { modelCalls: 1.5 },
    { modelCalls: Number.MAX_SAFE_INTEGER + 1 },
    { timeoutSeconds: 0 },
    { timeoutSeconds: -1 },
    { timeoutSeconds: 2147484 },
    { timeoutSeconds: Number.MAX_SAFE_INTEGER },
    { elapsedWallMs: 120000 },
  ];
  for (const budget of invalid)
    await assert.rejects(load({ ...definition, budget }), /budget/);
});

test('Reflection loads and locks an optional positive safe evidence byte budget', async (t) => {
  const { definition, load } = await fixture(t);
  const parsed = await load({
    ...definition,
    budget: { evidenceBytes: 64 * 1024 * 1024 },
  });
  assert.equal(parsed.budget.evidenceBytes, 64 * 1024 * 1024);
  assert.deepEqual(
    parseLockedReflection(JSON.parse(JSON.stringify(parsed))).budget,
    parsed.budget,
  );
  for (const evidenceBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      load({ ...definition, budget: { evidenceBytes } }),
      /budget.evidenceBytes/,
    );
  }
});
test('Reflection goal files resolve from the selected config and lock UTF-8 contents', async (t) => {
  const { root, definition, load } = await fixture(t);
  const first = await load();
  assert.equal(first.goal, 'Improve reusable guidance');
  await writeFile(join(root, 'goal.md'), 'Revised goal at the same path');
  const changed = await load();
  assert.notEqual(changed.digest, first.digest);
  assert.equal(changed.goal, 'Revised goal at the same path');
  await assert.rejects(
    load({ ...definition, goal: './missing.md' }),
    /goal: cannot read/,
  );
  await writeFile(join(root, 'goal.md'), '  \n');
  await assert.rejects(load(), /goal: file is empty/);
  await writeFile(join(root, 'goal.md'), Buffer.from([0xff]));
  await assert.rejects(load(), /goal: cannot read UTF-8/);
});
test('Reflection requires explicit registered implementation, contract and builtin Agent binding', async (t) => {
  const { definition, load } = await fixture(t);
  const implementations: JsonObject[] = [
    { contract: reflectionContract.id },
    { contract: reflectionContract.id, ref: '' },
    { ref: 'reflection.custom' },
    { contract: agentContract.id, ref: 'reflection.custom' },
    { contract: reflectionContract.id, ref: 'agent.test' },
    { contract: reflectionContract.id, ref: 'reflection.missing' },
  ];
  for (const implementation of implementations)
    await assert.rejects(
      load({ ...definition, implementation }),
      /implementation|Unknown plugin/,
    );
  const builtin = { contract: reflectionContract.id, ref: 'reflection.agent' };
  const agentConfigs: JsonObject[] = [
    {},
    { agentRef: '' },
    { agentRef: 'missing' },
    { agentRef: 'proposer' },
  ];
  for (const config of agentConfigs)
    await assert.rejects(
      load({ ...definition, implementation: { ...builtin, config } }),
      /agentRef/,
    );
  for (const field of ['maxContextBytes', 'maxModelCalls'])
    await assert.rejects(
      load({
        ...definition,
        implementation: {
          ...builtin,
          config: { agentRef: 'agent', [field]: 100 },
        },
      }),
      new RegExp(field),
    );
  const parsed = await load({
    ...definition,
    implementation: { ...builtin, config: { agentRef: 'agent' } },
  });
  assert.equal(parsed.implementation.config.agentRef, 'agent');
  assert.equal(parsed.implementation.config.maxModelCalls, undefined);
  assert.equal(parsed.implementation.config.maxContextBytes, undefined);
  assert.ok(
    (
      await readFile(String(parsed.implementation.config.prompt), 'utf8')
    ).trim(),
  );
  const zero = await load({
    ...definition,
    implementation: { ...builtin, config: { agentRef: 'agent.default' } },
    budget: { modelCalls: 0 },
  });
  assert.equal(zero.budget.modelCalls, 0);
  assert.equal(zero.implementation.config.maxModelCalls, undefined);
});
test('Reflection rejects legacy rules, unknown fields and invalid target or evidence authorization', async (t) => {
  const { definition, load } = await fixture(t);
  const invalid: JsonObject[] = [
    { rules: [] },
    { ...definition, enabled: true },
    { ...definition, evidence: [] },
    { ...definition, evidence: ['proposer', 'proposer'] },
    { ...definition, evidence: ['missing'] },
    { ...definition, targets: {} },
    { ...definition, targets: { missing: { resources: ['guidance'] } } },
    {
      ...definition,
      targets: { proposer: { resources: ['guidance', 'guidance'] } },
    },
    { ...definition, targets: { proposer: { resources: ['label'] } } },
    {
      ...definition,
      targets: { proposer: { resources: ['guidance'], config: [] } },
    },
    { ...definition, goal: ' ' },
  ];
  for (const value of invalid)
    await assert.rejects(load(value), /reflection\.yaml:/);
});
test('Reflection checks configured read-only resources before execution', async (t) => {
  const { root, load } = await fixture(t);
  await rm(join(root, 'prompt.md'));
  await assert.rejects(
    load(),
    /reflection.yaml.*targets.proposer\/prompt: cannot read resource/,
  );
});
const policy = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.config-test',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  defaults: {
    reflection: { configFile: './missing-is-not-read-during-compilation.yaml' },
  },
  output: '${{ steps.improve.output }}',
  steps: [{ id: 'improve', type: 'reflection' }],
};
test('Policy compiler registers Reflection separately from raw generator contracts and enforces serial empty calls', () => {
  const compiled = new Policy(policy);
  assert.equal(compiled.steps[0]?.type, 'reflection');
  assert.deepEqual(compiled.requirements, {});
  assert.throws(
    () => new Policy({ ...policy, defaults: {} }),
    /defaults.reflection/,
  );
  assert.throws(
    () =>
      new Policy({
        ...policy,
        require: { reflection: { contract: reflectionContract.id } },
      }),
    /reserved/,
  );
  assert.throws(
    () =>
      new Policy({
        ...policy,
        defaults: { reflection: { ref: './legacy.yaml' } },
      }),
    /migrate.*configFile/,
  );
  assert.throws(
    () => new Policy({ ...policy, defaults: { reflection: {} } }),
    /configFile/,
  );
  assert.throws(
    () =>
      new Policy({
        ...policy,
        steps: [
          { id: 'improve', type: 'reflection', with: { goal: 'Override' } },
        ],
      }),
    /unknown field with/,
  );
  assert.doesNotThrow(
    () =>
      new Policy({
        ...policy,
        steps: [{ id: 'improve', type: 'reflection' }],
      }),
  );
  const concurrent = {
    ...policy,
    output: {},
    steps: [
      {
        id: 'batch',
        type: 'foreach',
        foreach: [1],
        as: 'entry',
        key: '${{ entry }}',
        concurrency: 2,
        steps: [{ id: 'improve', type: 'reflection' }],
      },
    ],
  };
  assert.throws(() => new Policy(concurrent), /parallel.*Reflection/);
  const declarationOnly = new Policy({
    ...policy,
    output: {},
    steps: [],
  });
  assert.equal(declarationOnly.steps.length, 0);
});
test('Recipe validation loads only the selected whole Reflection file before execution', async (t) => {
  const { root, registry, bindings, definition, load } = await fixture(t);
  await load();
  const runtime = await createRuntime({ rootDirectory: join(root, 'runtime') });
  t.after(() => runtime.dispose());
  for (const id of ['reflection.custom', 'proposer.test'])
    runtime.registry.registerOperation(registry.get(id));
  runtime.registry.registerOperation({
    id: 'application.test',
    contract: applicationContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create() {
      throw new Error('validation must not instantiate the Application');
    },
  });
  const selected = join(root, 'reflection.yaml');
  const policyPath = join(root, 'policy.yaml');
  const definitionPolicy: JsonObject = {
    schemaVersion: 'rsi.policy/v1',
    id: 'policy.preflight',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: {
      proposer: { contract: proposerContract.id },
      other: { contract: proposerContract.id },
    },
    defaults: {
      reflection: { configFile: './missing-default.yaml' },
      bindings: {
        proposer: {
          plugin: bindings.proposer!.plugin,
          config: bindings.proposer!.config,
        },
        other: {
          plugin: bindings.other!.plugin,
          config: bindings.other!.config,
        },
      },
    },
    output: {},
    steps: [],
  };
  await writeFile(policyPath, stringify(definitionPolicy));
  runtime.registry.registerPolicy('policy.preflight', policyPath);
  const recipePath = join(root, 'recipe.yaml');
  const recipe: JsonObject = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'recipe.preflight',
    application: { plugin: 'application.test' },
    policy: { id: 'policy.preflight' },
    reflection: { configFile: './reflection.yaml' },
  };
  await writeFile(recipePath, stringify(recipe));
  assert.equal((await validateRecipe(runtime, recipePath)).valid, true);
  assert.deepEqual(await runtime.manager.facts.list('calls'), []);
  // An invalid selected override is never replaced by a valid default file.
  await writeFile(join(root, 'missing-default.yaml'), stringify(definition));
  await writeFile(selected, stringify({ ...definition, evidence: [] }));
  await assert.rejects(
    validateRecipe(runtime, recipePath),
    /reflection.yaml.*evidence/,
  );
  const withoutDeclaration = structuredClone(definitionPolicy);
  delete object(withoutDeclaration.defaults).reflection;
  await writeFile(policyPath, stringify(withoutDeclaration));
  await assert.rejects(
    validateRecipe(runtime, recipePath),
    /does not declare defaults.reflection/,
  );
});
