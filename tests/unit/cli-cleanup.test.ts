import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Evaluator, type CleanupOptions } from 'arsi-evaluator';
import { parseDocument } from 'yaml';
import type { JsonObject, RuntimeContext } from '../../src/contracts/index.js';
import { cleanupExperiment } from '../../src/entries/cli/cleanup.js';
import { runCommand } from '../../src/entries/cli/commands.js';
import { prepareEvaluationConfig } from '../../src/plugins/evaluator-operatorbench/service.js';
import {
  cleanupEvaluatorBinding,
  recordCleanupInput,
} from '../../src/plugins/shared/evaluator-adapter/cleanup.js';
import { managerFixture } from '../helpers/manager-fixture.js';
import {
  defineContract,
  reflectionContract,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { dispatchRecipeCleanup } from '../../src/runtime/manager/cleanup.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { digest, object } from '../../src/shared/json.js';

async function recordKernelInput(context: RuntimeContext): Promise<string> {
  const path = join(context.directory, 'sdk-config.json');
  const config = prepareEvaluationConfig(
    { benchmark: 'kernel', environment: 'docker' },
    {
      selected: { id: 'fixture', seed: 1 },
      operation: 'evaluate',
      directory: context.directory,
      manifest: join(context.directory, 'sdk-input', 'manifest.json'),
    },
  );
  await writeFile(path, JSON.stringify(config));
  await recordCleanupInput({ context, kind: 'kernel' }, path, process.env);
  return path;
}

async function useFixtureNetwork(t: TestContext, root: string): Promise<void> {
  const network = join(root, 'network.yaml');
  await writeFile(network, '{}\n');
  const previous = process.env.EVALUATOR_NETWORK_CONFIG;
  process.env.EVALUATOR_NETWORK_CONFIG = network;
  t.after(() => {
    if (previous === undefined) delete process.env.EVALUATOR_NETWORK_CONFIG;
    else process.env.EVALUATOR_NETWORK_CONFIG = previous;
  });
}

function fixtureCommand(
  { manager, dispose }: Awaited<ReturnType<typeof managerFixture>>,
  signal = new AbortController().signal,
) {
  return (...args: string[]) =>
    runCommand(args, {
      signal,
      openRuntime: async () => ({
        context: manager.context,
        manager,
        registry: manager.options.registry,
        dispose,
      }),
      releaseRuntime: dispose,
    });
}

for (const ending of ['failed', 'cancelled'] as const) {
  test(`CLI previews and cleans a ${ending} experiment and resumes its checkpoint`, async (t) => {
    const stop = new AbortController();
    let retry = false;
    const calls: string[] = [];
    let configPath = '';
    let logPath = '';
    const f = await managerFixture(
      async (context): Promise<JsonObject> => {
        calls.push(context.callId);
        if (calls.length === 1) {
          configPath = await recordKernelInput(context);
          logPath = join(context.directory, 'worker.log');
          await writeFile(logPath, 'completed first step\n');
          return { score: 1 };
        }
        if (!retry) {
          const error = new Error('fixture interruption');
          if (ending === 'cancelled') stop.abort(error);
          throw error;
        }
        return { done: true };
      },
      {
        budget: { elapsedWallMs: 120_000 },
        driverEvents: (events) =>
          events.on('rsi/cleanup', (ctx) =>
            cleanupEvaluatorBinding(ctx, 'kernel'),
          ),
        policy: {
          steps: [
            { id: 'first', type: 'invoke', use: 'driver', with: {} },
            { id: 'drive', type: 'invoke', use: 'driver', with: {} },
          ],
        },
      },
    );
    t.after(f.dispose);
    const { manager } = f;
    await useFixtureNetwork(t, manager.rootDirectory);
    const recipe = join(manager.rootDirectory, 'recipe.yaml');
    const command = fixtureCommand(f);
    await assert.rejects(
      manager.run(recipe, { id: 'test', signal: stop.signal }),
      /fixture interruption/,
    );
    assert.equal((await manager.get('test')).status, ending);
    await assert.rejects(manager.facts.read('resource-cleanup', 'test'), {
      code: 'ENOENT',
    });
    const firstCall = calls[0];
    const kind = 'evaluator-cleanup-test';
    const receipt = await manager.facts.read(kind, firstCall);
    assert.deepEqual(receipt.attempts, []);
    const savedState = () =>
      Promise.all([
        manager.get('test'),
        manager.facts.read('checkpoints', 'test'),
        manager.facts.list('checkpoint-entries'),
        manager.facts.list('calls'),
        manager.facts.read('definitions', 'test'),
        manager.facts.read('cleanup', 'test'),
        readFile(configPath),
        readFile(logPath),
      ]);
    const before = await savedState();

    const barrier = new EventEmitter();
    const entered = once(barrier, 'execute');
    const release = once(barrier, 'release');
    let failOnce = true;
    const sdk = t.mock.method(
      Evaluator.prototype,
      'cleanup',
      async (options: CleanupOptions) => {
        assert.equal(options.configPath, configPath);
        if (options.execute) {
          if (failOnce) {
            failOnce = false;
            throw new Error('fixture daemon unavailable');
          }
          barrier.emit('execute');
          await release;
        }
        return {
          preview: !options.execute,
          nodes: [
            {
              nodeId: 'local',
              daemonId: 'fixture',
              items: [
                {
                  reference: 'fixture/owned:1',
                  imageId: 'fixture-id',
                  status: options.execute ? 'deleted' : 'candidate',
                  reason: 'owned by the fixture',
                },
              ],
            },
          ],
        };
      },
    );
    const inspected = await command('cleanup', 'test', '--dry-run');
    assert.equal(inspected.exitCode, 0);
    const plan = JSON.parse(inspected.stdout!);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.results[0].status, 'preview');
    assert.deepEqual(plan.results[0].report.nodes[0].items[0], {
      reference: 'fixture/owned:1',
      imageId: 'fixture-id',
      status: 'candidate',
      reason: 'owned by the fixture',
    });
    assert.deepEqual(await manager.facts.read(kind, firstCall), receipt);
    assert.deepEqual(await savedState(), before);
    const partial = await command('cleanup', 'test');
    assert.equal(partial.exitCode, 1);
    const pending = JSON.parse(partial.stdout!).results[0];
    assert.equal(pending.status, 'pending');
    assert.match(pending.error, /fixture daemon unavailable/);
    assert.equal((await manager.facts.read(kind, firstCall)).status, 'pending');
    const execution = command('cleanup', 'test');
    try {
      await Promise.race([
        entered,
        execution.then(() =>
          assert.fail('cleanup did not execute the receipt'),
        ),
      ]);
      await assert.rejects(command('cleanup', 'test'), /in use/);
      await assert.rejects(
        command('run', recipe, '--id', 'test', '--resume'),
        /lock/i,
      );
      assert.equal((await command('cleanup', 'test', '--dry-run')).exitCode, 0);
    } finally {
      barrier.emit('release');
    }
    const cleaned = await execution;
    assert.equal(cleaned.exitCode, 0);
    const result = JSON.parse(cleaned.stdout!).results[0];
    assert.equal(result.status, 'complete');
    assert.equal(result.report.nodes[0].items[0].status, 'deleted');
    assert.equal(
      (await manager.facts.read(kind, firstCall)).status,
      'complete',
    );
    assert.deepEqual(await savedState(), before);
    const repeated = await command('cleanup', 'test');
    assert.deepEqual(JSON.parse(repeated.stdout!).results, []);
    assert.deepEqual(
      sdk.mock.calls.map((call) => call.arguments[0].execute),
      [false, true, true, false],
    );

    retry = true;
    const resumed = await command('run', recipe, '--id', 'test', '--resume');
    const experiment = JSON.parse(resumed.stdout!);
    assert.equal(experiment.id, 'test');
    assert.equal(experiment.status, 'succeeded');
    assert.deepEqual(experiment.output, { done: true });
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((id) => id === firstCall).length, 1);
  });
}

test('a fully reused evaluation notifies both its archived plugin and its unstarted replacement', async (t) => {
  let retry = false;
  const finish: OperationDefinition = {
    id: 'test.finish',
    contract: defineContract({
      id: 'contract.finish',
      input_schema: {},
      output_schema: {},
    }),
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          if (!retry) throw new Error('interrupted after evaluation');
          return { done: true };
        },
        async dispose() {},
      };
    },
  };
  let evaluations = 0;
  let disposals = 0;
  const f = await managerFixture(
    async (context) => {
      evaluations++;
      await recordKernelInput(context);
      return { score: 1 };
    },
    {
      plugins: [finish],
      bindings: { finish: { plugin: finish.id, config: {} } },
      policy: {
        steps: [
          { id: 'evaluate', type: 'invoke', use: 'driver', with: {} },
          { id: 'drive', type: 'invoke', use: 'finish', with: {} },
        ],
      },
      async disposeDriver() {
        disposals++;
      },
      driverEvents(events) {
        events.on('rsi/cleanup', () =>
          assert.fail('failed experiments keep resources'),
        );
      },
    },
  );
  t.after(f.dispose);
  await useFixtureNetwork(t, f.manager.rootDirectory);
  await assert.rejects(f.run(), /interrupted after evaluation/);
  assert.equal(disposals, 1);
  assert.deepEqual(await f.manager.facts.list('used-bindings'), []);
  const [receipt] = await f.manager.facts.list('evaluator-cleanup-test');
  assert.deepEqual(receipt.attempts, []);

  const registry = new Registry();
  const manager = new Manager({
    registry,
    rootDirectory: f.manager.rootDirectory,
  });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
  });
  registry.registerPolicy(
    'test.policy',
    join(manager.rootDirectory, 'policy.yaml'),
  );
  registry.registerOperation(
    f.manager.options.registry.get('test.application'),
  );
  registry.registerOperation(finish);
  const notified: string[] = [];
  registry.registerOperation(
    {
      ...f.manager.options.registry.get('test.driver'),
      id: 'test.replacement',
      async create() {
        return assert.fail('the replacement has no unfinished evaluation');
      },
    },
    (events) =>
      events.on('rsi/cleanup', ({ pluginId, bindingId }) => {
        notified.push(pluginId + '/' + bindingId);
        return [];
      }),
  );
  registry.registerOperation(
    {
      ...f.manager.options.registry.get('test.driver'),
      async create() {
        return assert.fail('a reused evaluation must not create an instance');
      },
    },
    (events) =>
      events.on('rsi/cleanup', (context) => {
        notified.push(context.pluginId + '/' + context.bindingId);
        return cleanupEvaluatorBinding(context, 'kernel');
      }),
  );
  const sdk = t.mock.method(
    Evaluator.prototype,
    'cleanup',
    async (options: CleanupOptions) => {
      assert.equal(options.execute, true);
      assert.equal(
        options.configPath,
        join(
          manager.directory,
          'experiments',
          'test',
          'calls',
          String(receipt.key),
          'sdk-config.json',
        ),
      );
      return {
        preview: false,
        nodes: [{ nodeId: 'local', daemonId: 'fixture', items: [] }],
      };
    },
  );
  retry = true;
  const recipe = join(manager.rootDirectory, 'recipe.yaml');
  const current = parseDocument(await readFile(recipe, 'utf8'));
  current.setIn(['bindings', 'driver', 'plugin'], 'test.replacement');
  await writeFile(recipe, current.toString());
  const result = await manager.run(recipe, { id: 'test', resume: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(evaluations, 1);
  const expected = ['test.replacement/driver', 'test.driver/driver'];
  assert.deepEqual(notified, expected);
  assert.equal(sdk.mock.callCount(), 1);
  assert.equal(
    (await manager.facts.read('evaluator-cleanup-test', String(receipt.key)))
      .status,
    'complete',
  );
  const report = await manager.facts.read('resource-cleanup', 'test');
  assert.equal(report.status, 'complete');
  assert.ok(Array.isArray(report.results));
  assert.deepEqual(
    report.results.map((entry) => object(entry).pluginId),
    ['test.driver'],
  );
  assert.deepEqual(
    await manager.run(recipe, { id: 'test', resume: true }),
    result,
  );
  assert.deepEqual(notified, [...expected, ...expected]);
  assert.equal(sdk.mock.callCount(), 1);
});

test('completed resume retries pending resource cleanup after instance disposal without repeating business calls', async (t) => {
  const log: string[] = [];
  let ready = false;
  const f = await managerFixture(
    async () => {
      log.push('execute');
      return {};
    },
    {
      async disposeDriver() {
        await Promise.resolve();
        log.push('dispose');
      },
      driverEvents(events) {
        events.on('rsi/cleanup', async () => {
          log.push('cleanup');
          if (!ready) throw new Error('unavailable');
          return [{ key: 'owned', status: 'complete' }];
        });
      },
    },
  );
  t.after(f.dispose);
  const result = await f.run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(log, ['execute', 'dispose', 'cleanup']);
  assert.equal(
    (await f.manager.facts.read('resource-cleanup', 'test')).status,
    'pending',
  );
  ready = true;
  assert.deepEqual(
    await f.manager.run(join(f.manager.rootDirectory, 'recipe.yaml'), {
      id: 'test',
      resume: true,
    }),
    result,
  );
  assert.deepEqual(log, ['execute', 'dispose', 'cleanup', 'cleanup']);
  assert.equal(
    (await f.manager.facts.read('resource-cleanup', 'test')).status,
    'complete',
  );
});

test('manual cleanup awaits each distinct binding in this experiment’s saved Recipes', async (t) => {
  const notified: string[] = [];
  let active = 0;
  const f = await managerFixture(
    async () => {
      throw new Error('stop before cleanup');
    },
    {
      bindings: {
        second: { plugin: 'test.driver', config: {} },
        retired: { plugin: 'test.driver', config: {} },
      },
      driverEvents(events) {
        events.on('rsi/cleanup', async ({ bindingId, pluginId, dryRun }) => {
          assert.equal(++active, 1);
          await new Promise<void>((resolve) => setImmediate(resolve));
          notified.push(pluginId + '/' + bindingId);
          active--;
          return [{ key: bindingId, status: dryRun ? 'preview' : 'complete' }];
        });
      },
    },
  );
  t.after(f.dispose);
  const { manager } = f;
  const registry = manager.options.registry;
  const driver = registry.get('test.driver');
  registry.registerOperation({ ...driver, id: 'test.old' }, (events) =>
    events.on('rsi/cleanup', ({ pluginId, bindingId }) => {
      notified.push(pluginId + '/' + bindingId);
      throw new Error('temporarily unavailable');
    }),
  );
  const unload = registry.registerOperation({ ...driver, id: 'test.missing' });
  registry.registerOperation({ ...driver, id: 'test.foreign' }, (events) =>
    events.on('rsi/cleanup', () =>
      assert.fail('another experiment received cleanup'),
    ),
  );
  const path = join(manager.rootDirectory, 'recipe.yaml');
  const recipe = parseDocument(await readFile(path, 'utf8'));
  recipe.setIn(['bindings', 'retired', 'plugin'], 'test.missing');
  for (const [id, pluginId, resume] of [
    ['peer', 'test.foreign', false],
    ['test', 'test.old', false],
    ['test', 'test.driver', true],
    ['test', 'test.driver', true],
  ] as const) {
    recipe.setIn(['bindings', 'driver', 'plugin'], pluginId);
    await writeFile(path, recipe.toString());
    await assert.rejects(
      manager.run(path, { id, resume }),
      /stop before cleanup/,
    );
  }
  unload();
  assert.deepEqual(notified, []);
  const signal = new AbortController().signal;
  for (const dryRun of [true, false]) {
    const { results } = await cleanupExperiment(
      manager,
      'test',
      dryRun,
      signal,
    );
    assert.deepEqual(notified.splice(0).sort(), [
      'test.driver/driver',
      'test.driver/second',
      'test.old/driver',
    ]);
    const success = dryRun ? 'preview' : 'complete';
    assert.deepEqual(
      results
        .map(({ pluginId, bindingId, status }) => [pluginId, bindingId, status])
        .sort(),
      [
        ['test.driver', 'driver', success],
        ['test.driver', 'second', success],
        ['test.missing', 'retired', 'pending'],
        ['test.old', 'driver', 'pending'],
      ],
    );
    assert.match(
      results.find((item) => item.pluginId === 'test.missing')!.error!,
      /Unknown plugin/,
    );
  }

  // A misplaced lock must not dispatch any callback using another experiment's archive.
  const misplaced = await manager.facts.read('definitions', 'test');
  await manager.facts.write('definitions', 'peer', misplaced);
  await assert.rejects(
    cleanupExperiment(manager, 'peer', false, signal),
    /Invalid archived definition/,
  );
  assert.deepEqual(notified, []);
});

test('standalone cleanup previews saved Application and Reflection bindings without opening the original files', async (t) => {
  const f = await managerFixture(async () => ({}));
  t.after(f.dispose);
  const { manager } = f;
  const registry = manager.options.registry;
  for (const definition of [
    { ...registry.get('test.application'), id: 'test.app' },
    {
      ...registry.get('test.driver'),
      contract: reflectionContract,
      id: 'test.reflection',
    },
  ]) {
    registry.registerOperation(definition, (events) =>
      events.on('rsi/cleanup', async ({ bindingId, facts }) => {
        await assert.rejects(
          async () => facts.write('preview-writes', bindingId, {}),
          /Cleanup previews cannot write facts/,
        );
        return [{ key: bindingId, status: 'preview' }];
      }),
    );
  }
  const recipe = {
    application: { plugin: 'test.app', config: {} },
    bindings: {},
    reflection: { configFile: 'removed.yaml' },
  };
  const id = 'saved';
  await manager.facts.write('experiments', id, {
    id,
    status: 'failed',
    recipe,
  });
  const preview = async () => {
    const results = await dispatchRecipeCleanup(registry, {
      experimentId: id,
      dataDirectory: manager.directory,
      facts: manager.facts,
      dryRun: true,
      signal: new AbortController().signal,
    });
    return results.map(({ bindingId, pluginId, status }) => {
      assert.equal(status, 'preview');
      return [bindingId, pluginId];
    });
  };
  // A failure before the definition lock still leaves the Application in the saved Recipe.
  assert.deepEqual(await preview(), [['_application', 'test.app']]);

  const definition = {
    schemaVersion: 'rsi.definition-lock/v1',
    recipe,
    reflection: { implementation: { ref: 'test.reflection', config: {} } },
  };
  await manager.facts.write('definitions', id, {
    ...definition,
    digest: digest(definition),
  });
  assert.deepEqual(await preview(), [
    ['_application', 'test.app'],
    ['_reflection', 'test.reflection'],
  ]);
});

test('an active experiment can be previewed while execution stays with its owner', async (t) => {
  const barrier = new EventEmitter();
  const entered = once(barrier, 'running');
  const release = once(barrier, 'release');
  const f = await managerFixture(async () => {
    barrier.emit('running');
    await release;
    return { done: true };
  });
  t.after(f.dispose);
  const command = fixtureCommand(f);
  const signal = new AbortController().signal;
  const running = f.run();
  try {
    await Promise.race([
      entered,
      running.then(() => assert.fail('experiment already ended')),
    ]);
    assert.deepEqual(await cleanupExperiment(f.manager, 'test', true, signal), {
      experimentId: 'test',
      dryRun: true,
      results: [],
    });
    await assert.rejects(
      cleanupExperiment(f.manager, 'test', false, signal),
      /in use/,
    );
    await f.manager.facts.write('experiments', 'z-idle', {
      id: 'z-idle',
      status: 'cancelled',
    });
    const batch = await command('cleanup', '--all');
    assert.equal(batch.exitCode, 0);
    const [busy, idle] = JSON.parse(batch.stdout!).experiments;
    assert.equal(busy.experimentId, 'test');
    assert.equal(busy.status, 'skipped');
    assert.match(busy.reason, /in use/);
    assert.deepEqual(idle, {
      experimentId: 'z-idle',
      status: 'complete',
      results: [],
    });
    assert.equal((await f.manager.get('test')).status, 'running');
  } finally {
    barrier.emit('release');
    await running;
  }
});

test('workspace previews are read-only and --all continues past failed and pending experiments', async (t) => {
  const paths = new Map<string, string>();
  const f = await managerFixture(
    async (context) => {
      paths.set(await recordKernelInput(context), context.experimentId);
      throw new Error('keep resources for manual cleanup');
    },
    {
      budget: { elapsedWallMs: 120_000 },
      driverEvents: (events) =>
        events.on('rsi/cleanup', (ctx) =>
          cleanupEvaluatorBinding(ctx, 'kernel'),
        ),
    },
  );
  t.after(f.dispose);
  const { manager } = f;
  await useFixtureNetwork(t, manager.rootDirectory);
  const command = fixtureCommand(f);
  const ids = ['b-retry', 'c-ready'];
  const recipe = join(manager.rootDirectory, 'recipe.yaml');
  for (const id of ids)
    await assert.rejects(manager.run(recipe, { id }), /keep resources/);
  const receipts = () =>
    Promise.all(ids.map((id) => manager.facts.list(`evaluator-cleanup-${id}`)));
  const before = await receipts();
  const executed: string[] = [];
  t.mock.method(
    Evaluator.prototype,
    'cleanup',
    async ({ configPath, execute }: CleanupOptions) => {
      const id = paths.get(configPath);
      assert.ok(id);
      if (execute) {
        executed.push(id);
        if (id === 'b-retry' && executed.length === 1)
          throw new Error('fixture unavailable');
      }
      return {
        preview: !execute,
        nodes: [{ nodeId: 'local', daemonId: 'fixture', items: [] }],
      };
    },
  );
  for (const args of [[], ['--dry-run'], ['--all', '--dry-run']]) {
    const preview = await command('cleanup', ...args);
    assert.equal(preview.exitCode, 0);
    const { dryRun, experiments } = JSON.parse(preview.stdout!);
    assert.equal(dryRun, true);
    assert.deepEqual(
      experiments.map((entry: { experimentId: string }) => entry.experimentId),
      ids,
    );
    for (const entry of experiments) {
      assert.equal(entry.status, 'preview');
      assert.equal(entry.results[0].report.preview, true);
    }
  }
  assert.deepEqual(executed, []);
  assert.deepEqual(await receipts(), before);

  await writeFile(
    join(manager.directory, 'facts', 'experiments', 'a-damaged.json'),
    '{',
  );
  const first = await command('cleanup', '--all');
  assert.equal(first.exitCode, 1);
  const {
    dryRun,
    experiments: [damaged, pending, complete],
  } = JSON.parse(first.stdout!);
  assert.equal(dryRun, false);
  assert.equal(damaged.experimentId, 'a-damaged');
  assert.equal(damaged.status, 'failed');
  assert.ok(damaged.error);
  assert.equal(pending.status, 'pending');
  assert.match(pending.results[0].error, /fixture unavailable/);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.results[0].report.preview, false);
  assert.deepEqual(executed, ids);
  assert.deepEqual(
    (await receipts()).map(([entry]) => entry.status),
    ['pending', 'complete'],
  );

  await manager.facts.write('experiments', 'a-damaged', {
    id: 'a-damaged',
    status: 'failed',
  });
  const retry = await command('cleanup', '--all');
  assert.equal(retry.exitCode, 0);
  assert.deepEqual(JSON.parse(retry.stdout!).experiments[2].results, []);
  assert.deepEqual(executed, [...ids, 'b-retry']);
});

test('workspace cleanup retains the current binding result when dispatch is interrupted', async (t) => {
  const stop = new AbortController();
  const f = await managerFixture(
    async () => {
      throw new Error('keep resources');
    },
    {
      bindings: { second: { plugin: 'test.driver', config: {} } },
      driverEvents(events) {
        events.on('rsi/cleanup', ({ bindingId }) => {
          stop.abort(new Error('interrupted during cleanup'));
          return [{ key: bindingId, status: 'complete' }];
        });
      },
    },
  );
  t.after(f.dispose);
  await assert.rejects(f.run(), /keep resources/);
  const result = await fixtureCommand(f, stop.signal)('cleanup', '--all');
  assert.equal(result.exitCode, 130);
  const [experiment] = JSON.parse(result.stdout!).experiments;
  assert.equal(experiment.status, 'interrupted');
  assert.deepEqual(experiment.results, [
    {
      key: 'driver',
      status: 'complete',
      pluginId: 'test.driver',
      bindingId: 'driver',
    },
  ]);
});

test('an empty workspace stays empty and interruption stops before the next experiment', async (t) => {
  const f = await managerFixture(async () => ({}));
  t.after(f.dispose);
  const stop = new AbortController();
  const command = fixtureCommand(f, stop.signal);
  for (const args of [[], ['--all']]) {
    const empty = await command('cleanup', ...args);
    assert.equal(empty.exitCode, 0);
    assert.deepEqual(JSON.parse(empty.stdout!), {
      dryRun: !args.length,
      experiments: [],
    });
  }
  await assert.rejects(stat(f.manager.directory), { code: 'ENOENT' });
  for (const id of ['first', 'second'])
    await f.manager.facts.write('experiments', id, { id, status: 'failed' });
  const get = f.manager.get.bind(f.manager);
  const reads = t.mock.method(f.manager, 'get', async (id: string) => {
    stop.abort(new Error('fixture interruption'));
    return get(id);
  });
  const interrupted = await command('cleanup', '--all');
  assert.equal(interrupted.exitCode, 130);
  assert.deepEqual(JSON.parse(interrupted.stdout!).experiments, [
    {
      experimentId: 'first',
      status: 'interrupted',
      reason: 'fixture interruption',
      results: [],
    },
  ]);
  assert.deepEqual(
    reads.mock.calls.map((call) => call.arguments),
    [['first']],
  );
});
