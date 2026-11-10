import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PINNED_NODE_IMAGE } from 'ember-evaluator';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { createEvaluatorChecks } from '../../src/runtime/doctor/evaluator-checks.js';
import { object } from '../../src/shared/json.js';
import type {
  DoctorCheck,
  DoctorContext,
  MissingResource,
} from '../../src/runtime/doctor/types.js';
import type { runCommand } from '../../src/runtime/doctor/process.js';

async function fixture(t: test.TestContext): Promise<{
  directory: string;
  registry: Registry;
  recipe: Recipe;
  context(
    config: JsonObject,
    pluginId?: string,
  ): {
    ctx: DoctorContext;
    checks: DoctorCheck[];
    missing: Omit<MissingResource, 'binding' | 'pluginId'>[];
  };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-doctor-evaluator-'));
  const previousNetwork = process.env.EVALUATOR_NETWORK_CONFIG;
  const previousKey = process.env.DOCTOR_TEST_KEY;
  process.env.DOCTOR_TEST_KEY = 'fixture-key-never-print';
  process.env.EVALUATOR_NETWORK_CONFIG = join(directory, 'network.yaml');
  await writeFile(process.env.EVALUATOR_NETWORK_CONFIG, '{}\n');
  const registry = new Registry();
  t.after(async () => {
    if (previousNetwork === undefined)
      delete process.env.EVALUATOR_NETWORK_CONFIG;
    else process.env.EVALUATOR_NETWORK_CONFIG = previousNetwork;
    if (previousKey === undefined) delete process.env.DOCTOR_TEST_KEY;
    else process.env.DOCTOR_TEST_KEY = previousKey;
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await registerBuiltins(registry);
  const recipe = await Recipe.fromJSON(
    {
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-evaluator',
      application: {
        plugin: 'application.agentbundle',
        config: {
          target: {
            schema: resolve('examples/harness/dsh-harness2/target.yaml'),
          },
          baseline: {
            directory: resolve('examples/harness/dsh-harness2/baseline'),
          },
        },
      },
      policy: {
        id: 'policy.harness2',
        config: { dataset: { taskIds: ['fixture'] } },
      },
      bindings: {
        evaluator: {
          plugin: 'evaluator.agentbench',
          config: {
            benchmark: 'workbuddy',
            services: {
              default: {
                model: 'fixture',
                base_url: 'http://localhost:1234/v1',
                api_key: '${DOCTOR_TEST_KEY}',
              },
            },
          },
        },
      },
    },
    registry,
    { sourcePath: join(directory, 'recipe.yaml') },
  );
  return {
    directory,
    registry,
    recipe,
    context(config, pluginId = 'evaluator.agentbench') {
      const checks: DoctorCheck[] = [];
      const missing: Omit<MissingResource, 'binding' | 'pluginId'>[] = [];
      const ctx: DoctorContext = {
        binding: {
          name: 'evaluator',
          pluginId,
          definition: registry.get(pluginId),
          config,
        },
        recipe,
        registry,
        directory,
        runtime: new RuntimeContext(),
        signal: new AbortController().signal,
        async check(id, action, options) {
          try {
            await action(ctx.signal);
            checks.push({
              id,
              status: 'passed',
              ...(options?.details ? { details: options.details } : {}),
            });
            return true;
          } catch (error) {
            checks.push({
              id,
              status: 'failed',
              reason: error instanceof Error ? error.message : String(error),
              ...(options?.details ? { details: options.details } : {}),
            });
            return false;
          }
        },
        unchecked(id, reason, details) {
          checks.push({
            id,
            status: 'unchecked',
            reason,
            ...(details ? { details } : {}),
          });
        },
        missing(resource) {
          missing.push(resource);
        },
      };
      return { ctx, checks, missing };
    },
  };
}

function agentConfig(directory: string): JsonObject {
  return {
    benchmark: {
      name: 'harbor',
      solver: { name: 'agentbundle' },
      config: {
        dataset: 'fixture-dataset',
        source: { kind: 'local', path: join(directory, 'dataset') },
        tasks: { root: '.', id: 'directory', expectedCount: 1 },
      },
    },
    services: {
      default: {
        model: 'fixture',
        base_url: 'http://localhost:1234/v1',
        api_key: '${DOCTOR_TEST_KEY}',
      },
    },
  };
}

async function dataset(directory: string): Promise<void> {
  const root = join(directory, 'dataset', 'fixture');
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'environment'));
  await writeFile(
    join(root, 'task.toml'),
    '[environment]\ndocker_image="fixture:cached"\nworkdir="/app"\ncpus=1\nmemory="32m"\n',
  );
  await writeFile(join(root, 'instruction.md'), 'Fixture instruction.');
  await writeFile(join(root, 'tests', 'test.sh'), 'exit 0\n');
}

test('agentbench checks cached task metadata and gateway without downloads or inference', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Doctor attempted a host download or model request');
  });
  const f = await fixture(t);
  await dataset(f.directory);
  const inventory = await readdir(join(f.directory, 'dataset'), {
    recursive: true,
  });
  const { ctx, checks, missing } = f.context(agentConfig(f.directory));
  const calls: { args: readonly string[]; input?: string }[] = [];
  const command: typeof runCommand = async (_command, args, options) => {
    calls.push({ args, input: options.input });
    return {
      stdout:
        args[0] === 'info'
          ? JSON.stringify({
              MemTotal: 1024 ** 3,
              NCPU: 2,
              OSType: 'linux',
              Architecture: 'x86_64',
              Driver: 'overlay2',
            })
          : '',
      stderr: '',
    };
  };
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.some((check) => check.status === 'failed'),
    false,
    JSON.stringify(checks),
  );
  for (const id of [
    'configuration',
    'sdk-configuration',
    'task-metadata',
    'docker-capacity',
    'workspace-cache-mounts',
    'gateway-model-access',
  ])
    assert.equal(checks.find((check) => check.id === id)?.status, 'passed', id);
  assert.deepEqual(missing, []);
  const launches = calls.filter((call) => call.args[0] === 'run');
  assert.equal(launches.length, 2);
  assert.ok(launches.every((call) => call.args.includes('--pull=never')));
  assert.ok(
    calls.every(
      (call) => !call.args.includes('pull') && !call.args.includes('build'),
    ),
  );
  assert.equal(
    calls.filter((call) => call.args[0] === 'rm').length,
    launches.length,
  );
  assert.match(launches[1].input ?? '', /host\.docker\.internal/);
  assert.ok(
    calls.every(
      (call) => !JSON.stringify(call.args).includes('fixture-key-never-print'),
    ),
  );
  assert.deepEqual(
    await readdir(join(f.directory, 'dataset'), { recursive: true }),
    inventory,
  );
});

test('relative SDK source origins are not mistaken for caller-directory resources', async (t) => {
  const f = await fixture(t);
  const config = agentConfig(f.directory);
  config.benchmark = {
    name: 'harbor',
    solver: { name: 'agentbundle' },
    config: {
      source: { kind: 'local', path: '.' },
      tasks: { root: '.', id: 'directory' },
    },
  };
  const { ctx, checks, missing } = f.context(config);
  const command: typeof runCommand = async (_command, args) => ({
    stdout:
      args[0] === 'info'
        ? JSON.stringify({
            MemTotal: 1024 ** 3,
            NCPU: 2,
            OSType: 'linux',
            Architecture: 'x86_64',
            Driver: 'overlay2',
          })
        : '',
    stderr: '',
  });
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.find((check) => check.id === 'task-metadata')?.status,
    'unchecked',
  );
  assert.match(
    checks.find((check) => check.id === 'task-metadata')?.reason ?? '',
    /per-evaluation SDK configuration directory/,
  );
  assert.equal(
    checks.some((check) => check.status === 'failed'),
    false,
    JSON.stringify(checks),
  );
  assert.deepEqual(missing, []);
});

test('cached metadata retains the SDK source host-platform requirement', async (t) => {
  const f = await fixture(t);
  await dataset(f.directory);
  const config = agentConfig(f.directory);
  object(object(config.benchmark).config).source = {
    kind: 'local',
    path: join(f.directory, 'dataset'),
    hostPlatform: process.platform === 'linux' ? 'win32' : 'linux',
  };
  const { ctx, checks } = f.context(config);
  const command: typeof runCommand = async (_command, args) => ({
    stdout:
      args[0] === 'info'
        ? JSON.stringify({
            MemTotal: 1024 ** 3,
            NCPU: 2,
            OSType: 'linux',
            Architecture: 'x86_64',
            Driver: 'overlay2',
          })
        : '',
    stderr: '',
  });
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.match(
    checks.find((check) => check.id === 'task-metadata')?.reason ?? '',
    /Source materialization requires/,
  );
  assert.equal(checks.find((check) => check.id === 'docker')?.status, 'passed');
});

test('cold SDK gateway cache leaves dependent checks unchecked and never launches containers', async (t) => {
  const f = await fixture(t);
  await dataset(f.directory);
  const { ctx, checks, missing } = f.context(agentConfig(f.directory));
  const mutableCalls: string[][] = [];
  const command: typeof runCommand = async (_command, args) => {
    mutableCalls.push([...args]);
    if (args.includes(PINNED_NODE_IMAGE))
      throw new Error('docker exited 1: No such image: gateway');
    return {
      stdout:
        args[0] === 'info'
          ? JSON.stringify({
              MemTotal: 1024 ** 3,
              NCPU: 2,
              OSType: 'linux',
              Architecture: 'x86_64',
              Driver: 'overlay2',
            })
          : '',
      stderr: '',
    };
  };
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.some((check) => check.status === 'failed'),
    false,
    JSON.stringify(checks),
  );
  assert.equal(
    checks.find((check) => check.id === 'docker-capacity')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'gateway-model-access')?.status,
    'unchecked',
  );
  assert.equal(
    missing.find((item) => item.kind === 'image')?.reference,
    PINNED_NODE_IMAGE,
  );
  assert.ok(
    mutableCalls.every(
      (args) => !args.includes('run') && !args.includes('pull'),
    ),
  );
  for (const item of missing)
    for (const id of item.checksNotRun)
      assert.equal(
        checks.find((check) => check.id === id)?.status,
        'unchecked',
      );
});

test('missing local dataset fails while independent Docker checks still execute', async (t) => {
  const f = await fixture(t);
  const { ctx, checks, missing } = f.context(agentConfig(f.directory));
  const command: typeof runCommand = async (_command, args) => ({
    stdout:
      args[0] === 'info'
        ? JSON.stringify({
            MemTotal: 1024 ** 3,
            NCPU: 2,
            OSType: 'linux',
            Architecture: 'x86_64',
            Driver: 'overlay2',
          })
        : '',
    stderr: '',
  });
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.find((check) => check.id === 'dataset-source')?.status,
    'failed',
  );
  assert.equal(checks.find((check) => check.id === 'docker')?.status, 'passed');
  assert.equal(
    checks.find((check) => check.id === 'task-metadata')?.status,
    'unchecked',
  );
  assert.equal(missing[0].reference, join(f.directory, 'dataset'));
});

test('agentbench rejects solver and owned path conflicts before metadata preparation', async (t) => {
  const f = await fixture(t);
  const config = agentConfig(f.directory);
  config.benchmark = {
    name: 'workbuddy',
    solver: { name: 'simpleagent', config: { path: '/external' } },
  };
  const { ctx, checks } = f.context(config);
  const command: typeof runCommand = async () => {
    throw new Error('Docker unavailable');
  };
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.match(
    checks.find((check) => check.id === 'configuration')?.reason ?? '',
    /must be agentbundle/,
  );
  assert.equal(
    checks.find((check) => check.id === 'task-metadata')?.status,
    'unchecked',
  );
});

test('gateway failure releases its owned container and does not report a missing resource', async (t) => {
  const f = await fixture(t);
  await dataset(f.directory);
  const { ctx, checks, missing } = f.context(agentConfig(f.directory));
  let starts = 0;
  let removals = 0;
  const command: typeof runCommand = async (_command, args) => {
    if (args[0] === 'run') {
      starts++;
      throw new Error('Gateway probe timed out');
    }
    if (args[0] === 'rm') removals++;
    return {
      stdout:
        args[0] === 'info'
          ? JSON.stringify({
              MemTotal: 1024 ** 3,
              NCPU: 2,
              OSType: 'linux',
              Architecture: 'x86_64',
              Driver: 'overlay2',
            })
          : '',
      stderr: '',
    };
  };
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.find((check) => check.id === 'gateway-model-access')?.status,
    'failed',
  );
  assert.equal(starts, removals);
  assert.deepEqual(missing, []);
});

test('gateway cancellation releases its container using a live cleanup signal', async (t) => {
  const f = await fixture(t);
  await dataset(f.directory);
  const { ctx, checks } = f.context(agentConfig(f.directory));
  const controller = new AbortController();
  ctx.signal = controller.signal;
  let starts = 0;
  let removals = 0;
  const command: typeof runCommand = async (_command, args, options) => {
    if (args[0] === 'run') {
      starts++;
      if (args.includes('-i')) {
        queueMicrotask(() => controller.abort(new Error('Interrupted')));
        await new Promise<never>((_done, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      }
    }
    if (args[0] === 'rm') {
      assert.equal(options.signal.aborted, false);
      removals++;
    }
    return {
      stdout:
        args[0] === 'info'
          ? JSON.stringify({
              MemTotal: 1024 ** 3,
              NCPU: 2,
              OSType: 'linux',
              Architecture: 'x86_64',
              Driver: 'overlay2',
            })
          : '',
      stderr: '',
    };
  };
  await createEvaluatorChecks(command)['evaluator.agentbench'](ctx);
  assert.equal(
    checks.find((check) => check.id === 'gateway-model-access')?.status,
    'failed',
  );
  assert.equal(starts, removals);
});

test('inferencebench detects missing service and Application-owned overrides without launching', async (t) => {
  const f = await fixture(t);
  const data = f.recipe.toJSON();
  data.application = {
    plugin: 'application.inference',
    config: {
      target: { schema: resolve('examples/harness/dsh-harness2/target.yaml') },
      baseline: { directory: f.directory },
      start: { argv: [process.execPath] },
      endpoint: { model: 'fixture' },
    },
  };
  const recipe = await Recipe.fromJSON(data, f.registry, {
    sourcePath: join(f.directory, 'recipe.yaml'),
  });
  for (const [services, reason] of [
    [{ alternate: {} }, /services.default must be declared/],
    [
      { default: { model: 'external' } },
      /model is supplied by the Application/,
    ],
  ] as const) {
    const { ctx, checks } = f.context(
      { benchmark: 'agentx', services },
      'evaluator.inferencebench',
    );
    ctx.recipe = recipe;
    await createEvaluatorChecks()['evaluator.inferencebench'](ctx);
    assert.match(
      checks.find((check) => check.id === 'configuration')?.reason ?? '',
      reason,
    );
  }
  const { ctx, checks } = f.context(
    { benchmark: 'agentx', services: { default: {} } },
    'evaluator.inferencebench',
  );
  ctx.recipe = recipe;
  await createEvaluatorChecks()['evaluator.inferencebench'](ctx);
  assert.equal(
    checks.find((check) => check.id === 'configuration')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'sdk-configuration')?.status,
    'passed',
    JSON.stringify(checks),
  );
});

test('operatorbench loads task files and rejects duplicate case identities without kernel execution', async (t) => {
  const f = await fixture(t);
  const source = resolve('examples/artifacts/kernel/transpose-copy/task');
  for (const name of ['task.json', 'problem.py', 'test.py'])
    await writeFile(
      join(f.directory, name),
      await readFile(join(source, name)),
    );
  const config = { task: { directory: f.directory }, benchmark: 'kernel' };
  const positive = f.context(config, 'evaluator.operatorbench');
  await createEvaluatorChecks()['evaluator.operatorbench'](positive.ctx);
  assert.equal(
    positive.checks.find((check) => check.id === 'operator-task')?.status,
    'passed',
  );
  assert.equal(
    positive.checks.find((check) => check.id === 'sdk-configuration')?.status,
    'passed',
    JSON.stringify(positive.checks),
  );
  const path = join(f.directory, 'task.json');
  const definition: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(
    definition &&
      typeof definition === 'object' &&
      'cases' in definition &&
      Array.isArray(definition.cases),
  );
  definition.cases.push(definition.cases[0]);
  await writeFile(path, JSON.stringify(definition));
  const broken = f.context(config, 'evaluator.operatorbench');
  await createEvaluatorChecks()['evaluator.operatorbench'](broken.ctx);
  assert.match(
    broken.checks.find((check) => check.id === 'operator-task')?.reason ?? '',
    /case IDs must be unique/,
  );
  assert.equal(
    broken.checks.find((check) => check.id === 'sdk-configuration')?.status,
    'unchecked',
  );
});
