import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { RuntimeContext } from '../../src/contracts/index.js';
import { doctorRecipe } from '../../src/runtime/doctor/index.js';

test('an extension exports and registers its own doctor with effective config and isolated storage', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'doctor-definition-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = join(root, 'extension');
  await mkdir(extension);
  const secret = process.env.DOCTOR_PUBLIC_FIXTURE_SECRET;
  process.env.DOCTOR_PUBLIC_FIXTURE_SECRET = 'private-test-key-never-print';
  t.after(() => {
    if (secret === undefined) delete process.env.DOCTOR_PUBLIC_FIXTURE_SECRET;
    else process.env.DOCTOR_PUBLIC_FIXTURE_SECRET = secret;
  });
  const contracts = new URL('../../src/contracts/index.ts', import.meta.url)
    .href;
  const modulePath = join(extension, 'index.mjs');
  await writeFile(
    modulePath,
    `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { proposerContract, applicationContract } from ${JSON.stringify(contracts)};
export const calls = { doctor: 0, create: 0, execute: 0 };
export const customDefinition = {
  id: 'proposer.custom', contract: proposerContract,
  configSchema: { type: 'object', properties: {
    inputFile: { type: 'string', 'x-rsi-path': 'file' },
    label: { type: 'string', default: 'schema-default' }
  }, required: ['inputFile'], additionalProperties: false },
  async create() { calls.create++; return {
    async execute(input) { calls.execute++; return {status:'no-change',candidateRef:input.parent,diffRef:null,rationale:'fixture'}; },
    async dispose() {}
  }; },
  async doctor(context) {
    calls.doctor++;
    if (this.id !== context.binding.pluginId) throw Error('Doctor lost its definition receiver');
    const details = { pluginId: context.binding.pluginId, label: context.binding.config.label, input: context.binding.config.inputFile, directory: context.directory };
    await context.check('content', async signal => {
      await writeFile(join(context.directory, 'owned-marker'), 'owned');
      const content = await readFile(context.binding.config.inputFile, { encoding: 'utf8', signal });
      if (content !== 'ready') throw Error('Input must be ready: ' + process.env.DOCTOR_PUBLIC_FIXTURE_SECRET);
    }, { details });
  }
};
export function register(registry) {
  registry.registerOperation(customDefinition);
  registry.registerOperation({...customDefinition,id:'proposer.no-doctor',doctor:undefined});
  registry.registerOperation({id:'application.custom',contract:applicationContract,configSchema:{type:'object'},async create(){throw Error('Doctor must not create an uncovered Application');}});
  registry.registerPolicy('policy.custom-doctor', ${JSON.stringify(join(root, 'policy.json'))});
}
`,
  );
  const input = join(root, 'input.txt');
  await writeFile(input, 'ready');
  await writeFile(
    join(root, 'policy.json'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.custom-doctor',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        custom: { contract: 'contract.proposer' },
        independent: { contract: 'contract.selector-metrics' },
      },
      defaults: {
        bindings: {
          custom: {
            plugin: 'proposer.custom',
            config: { label: 'policy-default' },
          },
          independent: {
            plugin: 'selector.metric',
            config: { metric: 'score', direction: 'maximize' },
          },
        },
      },
      steps: [],
      output: {},
    }),
  );
  const data = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'custom-doctor',
    application: { plugin: 'application.custom', config: {} },
    policy: { id: 'policy.custom-doctor' },
    bindings: {
      custom: {
        plugin: 'proposer.custom',
        config: { inputFile: './input.txt', label: 'recipe-value' },
      },
    },
  };
  const path = join(root, 'recipe.json');
  await writeFile(path, JSON.stringify(data));
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
    pluginDirectories: [extension],
  });
  t.after(() => runtime.dispose());
  const module: { calls: { doctor: number; create: number; execute: number } } =
    await import(pathToFileURL(modulePath).href);
  const recipe = await Recipe.load(path, runtime.registry);
  assert.deepEqual(module.calls, { doctor: 0, create: 0, execute: 0 });
  const operation = await runtime.registry
    .get('proposer.custom')
    .create(recipe.bindings.custom.config, new RuntimeContext());
  await operation.execute(
    { parent: 'parent', goal: 'fixture', evidenceRefs: [] },
    new RuntimeContext(),
  );
  await operation.dispose();
  assert.deepEqual(module.calls, { doctor: 0, create: 1, execute: 1 });
  const report = await doctorRecipe(runtime, path);
  assert.equal(report.summary.failed, 0, JSON.stringify(report));
  const content = report.checks.find((check) => check.id === 'custom.content');
  assert.equal(content?.status, 'passed');
  assert.equal(content?.details?.pluginId, 'proposer.custom');
  assert.equal(content?.details?.input, input);
  assert.equal(content?.details?.label, 'recipe-value');
  assert.equal(typeof content?.details?.directory, 'string');
  await assert.rejects(access(String(content?.details?.directory)));
  assert.deepEqual(module.calls, { doctor: 1, create: 1, execute: 1 });
  await writeFile(input, 'broken');
  const broken = await doctorRecipe(runtime, path);
  assert.equal(
    broken.checks.find((check) => check.id === 'custom.content')?.status,
    'failed',
  );
  assert.equal(
    broken.checks.find((check) => check.id === 'independent.configuration')
      ?.status,
    'passed',
  );
  assert.ok(!JSON.stringify(broken).includes('private-test-key-never-print'));
  data.bindings.custom.plugin = 'proposer.no-doctor';
  await writeFile(path, JSON.stringify(data));
  const uncovered = await doctorRecipe(runtime, path);
  assert.equal(
    uncovered.checks.find((check) => check.id === 'custom.plugin')?.status,
    'unchecked',
  );
  assert.equal(
    uncovered.checks.find((check) => check.id === 'custom.resource.inputFile')
      ?.status,
    'passed',
  );
  assert.deepEqual(module.calls, { doctor: 2, create: 1, execute: 1 });
  assert.deepEqual(await runtime.manager.list(), []);
});
