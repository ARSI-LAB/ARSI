import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { object, string } from '../../src/shared/json.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { readPolicy } from '../../src/runtime/compiler/index.js';
import { kernelApplicationDefinition } from '../../src/plugins/application-kernel/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';
import { operatorbenchDefinition } from '../../src/plugins/evaluator-operatorbench/index.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';

useOperatorSdkTestEnvironment();

async function invokeInputs(
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  const module: unknown = await import(
    new URL('../../scripts/operator-inputs.mjs', import.meta.url).href
  );
  assert.ok(module && typeof module === 'object' && name in module);
  const method: unknown = Reflect.get(module, name);
  if (typeof method !== 'function')
    throw new Error(`Missing operator helper ${name}`);
  return await method(...args);
}

async function snapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-operator-inputs-'));
  const source = join(root, 'example');
  const buildDirectory = join(root, 'dist');
  const files = {
    'baseline/input.py': 'def kernel_function(x): return x\n',
    'task/task.json': '{"task":"fixed"}\n',
    'task/problem.py': 'reference source\n',
    'task/test.py': 'checks source\n',
    'target.yaml': 'target: fixed\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    const destination = join(source, name);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }
  const policyPath = join(
    buildDirectory,
    'src/policies/operator-baseline/policy.yaml',
  );
  await mkdir(resolve(policyPath, '..'), { recursive: true });
  await writeFile(
    join(buildDirectory, 'src/index.js'),
    'export const build = 1;\n',
  );
  await writeFile(
    policyPath,
    'schemaVersion: rsi.policy/v1\nid: policy.operator-baseline\n',
  );
  const recipePath = join(source, 'recipe.sdk.yaml');
  const recipe = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'operator-input-fixture',
    application: {
      plugin: 'application.kernel',
      config: {
        baseline: { directory: './baseline' },
        target: { schema: './target.yaml' },
      },
    },
    policy: { id: 'policy.operator-baseline', config: { caseIds: ['fixed'] } },
    bindings: {
      evaluator: {
        plugin: 'evaluator.operatorbench',
        config: {
          task: { directory: './task' },
          mode: 'sdk',
          protocol: {
            warmup: 5,
            repeat: 20,
            rtol: 0,
            atol: 0,
            timingScope: 'all-device-kernels',
          },
          sdk: {
            python: '/fixture/python',
            device: 0,
            timeoutSeconds: 15,
            profiling: { enabled: false },
          },
        },
      },
      selector: { plugin: 'selector.metric', config: {} },
    },
    budget: {
      operations: 30,
      evaluationRuns: 2,
      modelCalls: 0,
      elapsedWallMs: 180000,
      cleanupReserveMs: 30000,
    },
  };
  await writeFile(recipePath, stringify(recipe));
  const options = {
    buildDirectory,
    sdk: { python: '/fixture/python', device: 0, profiling: false },
  };
  async function prepare(id: string, resume = false) {
    return object(
      await invokeInputs('prepareOperatorInputs', recipePath, root, id, {
        ...options,
        resume,
      }),
    );
  }
  return {
    root,
    source,
    buildDirectory,
    policyPath,
    recipePath,
    recipe,
    options,
    prepare,
  };
}

test('SDK snapshots freeze an explicit profiler override and reject a changed tool on resume', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  object(fixture.recipe.bindings.evaluator.config.sdk).profiling = {
    enabled: false,
    collection: 'Default',
    warmup: 25,
    msprofBin: '/recipe/msprof',
  };
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  const options = {
    ...fixture.options,
    sdk: { ...fixture.options.sdk, msprofBin: '/isolated/msprof-fixed' },
  };
  const prepared = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'profiler',
      options,
    ),
  );
  const frozen = object(
    parse(await readFile(string(prepared.recipePath), 'utf8')),
  );
  assert.deepEqual(
    object(object(object(object(frozen.bindings).evaluator).config).sdk)
      .profiling,
    {
      enabled: false,
      collection: 'Default',
      warmup: 25,
      msprofBin: '/isolated/msprof-fixed',
    },
  );
  const manifest = object(
    JSON.parse(await readFile(string(prepared.manifestPath), 'utf8')),
  );
  assert.equal(
    object(manifest.executionParameters).msprofBin,
    '/isolated/msprof-fixed',
  );
  assert.deepEqual(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'profiler',
      { ...options, resume: true },
    ),
    prepared,
  );
  await assert.rejects(
    invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'profiler',
      {
        ...options,
        resume: true,
        sdk: { ...options.sdk, msprofBin: '/other/msprof' },
      },
    ),
    /parameters changed/i,
  );
  const unchanged = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'recipe-profiler',
      fixture.options,
    ),
  );
  const existing = object(
    parse(await readFile(string(unchanged.recipePath), 'utf8')),
  );
  assert.equal(
    object(
      object(object(object(object(existing.bindings).evaluator).config).sdk)
        .profiling,
    ).msprofBin,
    '/recipe/msprof',
  );
});

test('SDK baseline snapshots use only evaluator and selector and restore frozen inputs after source changes', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await fixture.prepare('first');
  const copied = object(
    parse(await readFile(string(first.recipePath), 'utf8')),
  );
  const inputDirectory = join(fixture.root, '.rsi/operator-sdk/first/inputs');
  const application = object(object(copied.application).config);
  const bindings = object(copied.bindings);
  assert.deepEqual(Object.keys(bindings).sort(), ['evaluator', 'selector']);
  assert.equal(object(copied.policy).id, 'policy.operator-baseline');
  assert.equal(
    object(application.baseline).directory,
    join(inputDirectory, 'baseline'),
  );
  assert.equal(
    object(application.target).schema,
    join(inputDirectory, 'target.yaml'),
  );
  assert.equal(
    object(object(object(bindings.evaluator).config).task).directory,
    join(inputDirectory, 'task'),
  );
  assert.equal(
    await readFile(
      join(
        inputDirectory,
        'runtime/src/policies/operator-baseline/policy.yaml',
      ),
      'utf8',
    ),
    await readFile(fixture.policyPath, 'utf8'),
  );
  const manifest = object(
    JSON.parse(await readFile(string(first.manifestPath), 'utf8')),
  );
  assert.equal(manifest.schemaVersion, 'rsi.operator-inputs/v2');
  assert.equal(manifest.id, 'first');
  assert.equal(object(manifest.source).recipePath, fixture.recipePath);
  await writeFile(
    join(fixture.source, 'baseline/input.py'),
    'new baseline source\n',
  );
  await writeFile(join(fixture.source, 'task/test.py'), 'changed checks\n');
  await writeFile(
    fixture.recipePath,
    'The original Recipe is no longer valid YAML: [\n',
  );
  assert.deepEqual(await fixture.prepare('first', true), first);
  assert.equal(
    await readFile(join(inputDirectory, 'baseline/input.py'), 'utf8'),
    'def kernel_function(x): return x\n',
  );
  assert.equal(
    await readFile(join(inputDirectory, 'task/test.py'), 'utf8'),
    'checks source\n',
  );
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  const second = await fixture.prepare('second');
  assert.notEqual(second.recipePath, first.recipePath);
  assert.equal(
    await readFile(
      join(string(second.recipePath), '../baseline/input.py'),
      'utf8',
    ),
    'new baseline source\n',
  );
});

test('calibration snapshots freeze 5/20 and 10/100 and support offline integrity checks', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = {
    ...fixture.options,
    sdk: { ...fixture.options.sdk, protocol: { warmup: 5, repeat: 20 } },
  };
  const first = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'main',
      options,
    ),
  );
  const adjusted = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'adjusted',
      {
        ...options,
        sdk: { ...options.sdk, protocol: { warmup: 10, repeat: 100 } },
      },
    ),
  );
  const original = object(
    await invokeInputs('inspectOperatorInputs', first.manifestPath),
  );
  assert.equal(
    original.identity,
    object(await invokeInputs('inspectOperatorInputs', adjusted.manifestPath))
      .identity,
  );
  const adjustedRecipe = object(
    parse(await readFile(string(adjusted.recipePath), 'utf8')),
  );
  assert.equal(
    object(
      object(object(object(adjustedRecipe.bindings).evaluator).config).protocol,
    ).repeat,
    100,
  );
  const alternate = structuredClone(fixture.recipe);
  alternate.application.config.baseline.directory = './alternate-baseline';
  await mkdir(join(fixture.source, 'alternate-baseline'));
  await writeFile(
    join(fixture.source, 'alternate-baseline/input.py'),
    'alternative source\n',
  );
  const alternatePath = join(fixture.source, 'alternate.yaml');
  await writeFile(alternatePath, stringify(alternate));
  const different = object(
    await invokeInputs(
      'prepareOperatorInputs',
      alternatePath,
      fixture.root,
      'different',
      options,
    ),
  );
  assert.notEqual(
    original.identity,
    object(await invokeInputs('inspectOperatorInputs', different.manifestPath))
      .identity,
  );
  await assert.rejects(
    invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'invalid',
      {
        ...options,
        sdk: { ...options.sdk, protocol: { warmup: 6, repeat: 20 } },
      },
    ),
    /5\/20 or 10\/100/,
  );
  await rm(fixture.buildDirectory, { recursive: true, force: true });
  assert.deepEqual(
    object(await invokeInputs('inspectOperatorInputs', first.manifestPath)),
    original,
  );
  await writeFile(string(first.recipePath), 'tampered');
  await assert.rejects(
    invokeInputs('inspectOperatorInputs', first.manifestPath),
    /integrity/,
  );
});

test('operator input recovery rejects copied-task changes and changed runtime Policy resources', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const copied = await fixture.prepare('copied-change');
  await writeFile(
    join(string(copied.recipePath), '../task/test.py'),
    'altered scoring rules\n',
  );
  await assert.rejects(
    fixture.prepare('copied-change', true),
    /snapshot.*(changed|mismatch)|integrity/i,
  );
  await fixture.prepare('policy-change');
  await writeFile(fixture.policyPath, 'changed runtime Policy\n');
  await assert.rejects(
    fixture.prepare('policy-change', true),
    /build.*(changed|mismatch)/i,
  );
  await assert.rejects(
    fixture.prepare('unknown', true),
    /snapshot.*(missing|exist|unknown)|ENOENT/i,
  );
});

test('operator inputs reject legacy v1 manifests without migrating archived evidence', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prepared = await fixture.prepare('legacy');
  const manifest = object(
    JSON.parse(await readFile(string(prepared.manifestPath), 'utf8')),
  );
  manifest.schemaVersion = 'rsi.operator-demo-inputs/v1';
  const legacy = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(string(prepared.manifestPath), legacy);
  await assert.rejects(
    fixture.prepare('legacy', true),
    /manifest.*identity|snapshot/i,
  );
  await assert.rejects(
    invokeInputs('inspectOperatorInputs', prepared.manifestPath),
    /snapshot/i,
  );
  assert.equal(await readFile(string(prepared.manifestPath), 'utf8'), legacy);
});

test('operator inputs reject external paths, symlinks, unsafe IDs and overwriting snapshots', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await fixture.prepare('existing');
  await assert.rejects(fixture.prepare('existing'), /already exists|resume/i);
  await assert.rejects(fixture.prepare('../escape'), /identifier|unsafe/i);
  await mkdir(join(fixture.root, 'outside'));
  fixture.recipe.bindings.evaluator.config.task.directory = '../outside';
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  await assert.rejects(fixture.prepare('external'), /outside|escape/i);
  fixture.recipe.bindings.evaluator.config.task.directory = './task';
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  await symlink(join(fixture.root, 'outside'), join(fixture.source, 'linked'));
  await assert.rejects(
    fixture.prepare('symlink'),
    /symbolic|symlink|ordinary/i,
  );
});

async function baselineManager(root: string, cancellation: AbortController) {
  const registry = new Registry();
  registry.registerOperation(kernelApplicationDefinition);
  registry.registerOperation(metricSelectorDefinition);
  const captureEvaluator: typeof operatorbenchDefinition = {
    ...operatorbenchDefinition,
    async create(config, services) {
      services.event.on('rsi/call-succeeded', (event) => {
        if (event.path === 'steps/evaluate_final')
          cancellation.abort(
            new Error('Stop after confirmed final measurement'),
          );
        return undefined;
      });
      return operatorbenchDefinition.create(config, services);
    },
  };
  registry.registerOperation(captureEvaluator);
  const path = resolve('src/policies/operator-baseline/policy.yaml');
  await readPolicy(path, registry);
  registry.registerPolicy('policy.operator-baseline', path);
  const manager = new Manager({ rootDirectory: root, registry });
  return {
    manager,
    async dispose() {
      await manager.dispose();
      await registry.dispose();
    },
  };
}

test('SDK baseline summary retains confirmed final evidence after cancellation without inventing Policy output', async (t) => {
  const fixture = await snapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sdk = await prepareOperatorFixture();
  t.after(() => rm(sdk.root, { recursive: true, force: true }));
  await cp(join(sdk.root, 'example'), fixture.source, { recursive: true });
  const prepared = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'after-final',
      {
        ...fixture.options,
        sdk: { python: sdk.worker, device: 0, profiling: false },
      },
    ),
  );
  const cancellation = new AbortController();
  const runtime = await baselineManager(fixture.root, cancellation);
  t.after(() => runtime.dispose());
  await assert.rejects(
    runtime.manager.run(string(prepared.recipePath), {
      id: 'after-final',
      signal: cancellation.signal,
    }),
    /confirmed final measurement/,
  );
  const experiment = await runtime.manager.get('after-final');
  assert.equal(experiment.output, undefined);
  const summary = object(
    await invokeInputs(
      'summarizeOperatorExperiment',
      runtime.manager,
      'after-final',
      prepared.manifestPath,
    ),
  );
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.mode, 'sdk');
  assert.equal(summary.reportSource, 'confirmed-receipts');
  assert.equal(summary.finalValidity, 'valid');
  assert.equal(object(summary.finalMeasurement).status, 'succeeded');
  assert.equal(summary.finalDecisionRef, null);
  assert.equal(summary.stopReason, null);
  assert.deepEqual(summary.attempts, []);
  assert.equal(
    await readFile(string(object(summary.bestSource).path), 'utf8'),
    await readFile(join(fixture.source, 'baseline/input.py'), 'utf8'),
  );
  assert.equal(object(summary.usage).evaluationRuns, 2);
});

async function hardwareSnapshotFixture(hardware: string | null) {
  const fixture = await snapshotFixture();
  const recipe = object(JSON.parse(JSON.stringify(fixture.recipe)));
  recipe.policy = {
    id: 'policy.operator-search',
    config: { maxAttempts: 3, repairLimit: 3 },
  };
  recipe.budget = {
    operations: 256,
    evaluationRuns: 14,
    modelCalls: 32,
    elapsedWallMs: 2400000,
    cleanupReserveMs: 60000,
  };
  const model = join(fixture.root, 'model');
  await mkdir(model);
  const identity = join(fixture.root, 'embedding-identity.json');
  await writeFile(identity, '{"model":"fixture"}');
  const bindings = object(recipe.bindings);
  bindings.agent = { plugin: 'agent.pi', config: { retries: 0 } };
  bindings.proposer = {
    plugin: 'proposer.operator',
    config: {
      task: { directory: './task' },
      embedding: {
        python: '/fixture/embedding-python',
        modelDirectory: model,
        identityFile: identity,
      },
      ...(hardware === null ? {} : { hardwareContextFile: hardware }),
    },
  };
  bindings.selector = {
    plugin: 'selector.metric',
    config: {
      metric: 'latencyMeanMs',
      direction: 'minimize',
      eligibility: [{ metric: 'candidateValid', min: 1 }],
    },
  };
  await writeFile(fixture.recipePath, stringify(recipe));
  const options = {
    ...fixture.options,
    kind: 'search',
    sdk: { ...fixture.options.sdk, profiling: false },
    embedding: {
      python: '/fixture/embedding-python',
      modelDirectory: model,
      identityFile: identity,
    },
  };
  const prepare = async (id: string, resume = false) =>
    object(
      await invokeInputs(
        'prepareOperatorInputs',
        fixture.recipePath,
        fixture.root,
        id,
        { ...options, resume },
      ),
    );
  return { ...fixture, recipe, prepare };
}

test('search snapshots freeze external hardware text and recovery ignores edits or removal of the original file', async (t) => {
  const fixture = await hardwareSnapshotFixture('../hardware-context.md');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const hardware = join(fixture.root, 'hardware-context.md');
  const original = '# Hardware\r\nUser supplied bytes.  \r\n';
  await writeFile(hardware, original);
  const first = await fixture.prepare('hardware');
  const copied = object(
    parse(await readFile(string(first.recipePath), 'utf8')),
  );
  const proposer = object(object(object(copied.bindings).proposer).config);
  const frozen = string(proposer.hardwareContextFile);
  assert.equal(
    frozen,
    join(
      fixture.root,
      '.rsi/operator-search/hardware/inputs/_operator-search/hardware-context.md',
    ),
  );
  assert.equal(await readFile(frozen, 'utf8'), original);
  const metadata = object(
    JSON.parse(
      await readFile(join(frozen, '../hardware-context.json'), 'utf8'),
    ),
  );
  assert.equal(
    metadata.sha256,
    (await import('node:crypto'))
      .createHash('sha256')
      .update(original)
      .digest('hex'),
  );
  assert.equal(JSON.stringify(metadata).includes(hardware), false);
  const originalIdentity = object(
    await invokeInputs('inspectOperatorInputs', first.manifestPath),
  ).identity;
  await writeFile(hardware, 'changed source');
  const second = await fixture.prepare('changed-hardware');
  assert.notEqual(
    object(await invokeInputs('inspectOperatorInputs', second.manifestPath))
      .identity,
    originalIdentity,
  );
  assert.deepEqual(await fixture.prepare('hardware', true), first);
  assert.equal(await readFile(frozen, 'utf8'), original);
  await rm(hardware);
  assert.deepEqual(await fixture.prepare('hardware', true), first);
});

test('search snapshots accept an absent hardware file option and reject configured missing or empty files before running', async (t) => {
  const optional = await hardwareSnapshotFixture(null);
  t.after(() => rm(optional.root, { recursive: true, force: true }));
  const prepared = await optional.prepare('optional');
  const recipe = object(
    parse(await readFile(string(prepared.recipePath), 'utf8')),
  );
  assert.equal(
    object(object(object(recipe.bindings).proposer).config).hardwareContextFile,
    undefined,
  );
  const required = await hardwareSnapshotFixture('../hardware-context.md');
  t.after(() => rm(required.root, { recursive: true, force: true }));
  await assert.rejects(
    required.prepare('missing-hardware'),
    /hardwareContextFile.*(read|exist|ENOENT)/i,
  );
  await writeFile(join(required.root, 'hardware-context.md'), ' \n');
  await assert.rejects(
    required.prepare('empty-hardware'),
    /hardwareContextFile.*empty/i,
  );
  await assert.rejects(
    readFile(
      join(required.root, '.rsi/operator-search/empty-hardware/manifest.json'),
    ),
    /ENOENT/,
  );
});

test('operator summary preserves diagnostic-only progress and separates call purposes', async () => {
  const summary = object(
    await invokeInputs(
      'summarizeOperatorExperiment',
      {
        async get() {
          return {
            status: 'succeeded',
            output: {
              attempts: [],
              metricsRounds: [],
              diagnosticRefs: [],
              diagnosticMeasurementRef: null,
              collectionStatus: 'unavailable',
              phase: 'metrics',
              stopReason: 'diagnostic-only',
            },
          };
        },
        facts: {
          async list(kind: string) {
            return kind === 'calls'
              ? [
                  {
                    experimentId: 'exp',
                    pluginId: 'evaluator.operatorbench',
                    input: { action: 'profile' },
                    status: 'succeeded',
                  },
                ]
              : [];
          },
        },
      },
      'exp',
      '/unused/manifest.json',
    ),
  );
  assert.equal(summary.collectionStatus, 'unavailable');
  assert.deepEqual(summary.metricsRounds, []);
  assert.deepEqual(summary.sdkCalls, { evaluate: 0, profile: 1 });
});

test('metrics snapshot freezes a two-round override and rejects changed recovery parameters', async (t) => {
  const fixture = await hardwareSnapshotFixture(null);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  object(object(fixture.recipe.policy).config).metricsEnabled = true;
  object(object(fixture.recipe.policy).config).maxRounds = 10;
  fixture.recipe.budget = {
    operations: 1024,
    evaluationRuns: 65,
    modelCalls: 152,
    elapsedWallMs: 7200000,
    cleanupReserveMs: 60000,
  };
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  const options = {
    ...fixture.options,
    kind: 'search',
    maxRounds: 2,
    embedding: {
      python: '/fixture/embedding-python',
      modelDirectory: join(fixture.root, 'model'),
      identityFile: join(fixture.root, 'embedding-identity.json'),
    },
  };
  const first = object(
    await invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'two-rounds',
      options,
    ),
  );
  const copied = object(
    parse(await readFile(string(first.recipePath), 'utf8')),
  );
  assert.equal(object(object(copied.policy).config).maxRounds, 2);
  assert.equal(object(object(fixture.recipe.policy).config).maxRounds, 10);
  for (const field of [
    'evaluationTimeoutMs',
    'modelRequestTimeoutMs',
    'retrievalTimeoutMs',
    'cleanupReserveMs',
  ]) {
    object(object(fixture.recipe.policy).config)[field] = 1;
    await writeFile(fixture.recipePath, stringify(fixture.recipe));
    await assert.rejects(
      invokeInputs(
        'prepareOperatorInputs',
        fixture.recipePath,
        fixture.root,
        `under-${field}`,
        options,
      ),
      /timeout|reserve|owner/i,
    );
    delete object(object(fixture.recipe.policy).config)[field];
  }
  await writeFile(fixture.recipePath, stringify(fixture.recipe));
  await assert.rejects(
    invokeInputs(
      'prepareOperatorInputs',
      fixture.recipePath,
      fixture.root,
      'two-rounds',
      { ...options, maxRounds: 3, resume: true },
    ),
    /parameters|differ/,
  );
});
