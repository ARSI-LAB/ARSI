import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { createAgentbenchDoctor } from '../../src/plugins/evaluator-agentbench/doctor.js';
import { createInferencebenchDoctor } from '../../src/plugins/evaluator-inferencebench/doctor.js';
import { createOperatorbenchDoctor } from '../../src/plugins/evaluator-operatorbench/doctor.js';
import type { SdkDoctorRunner } from '../../src/plugins/shared/evaluator-adapter/doctor-sdk.js';
import { object } from '../../src/shared/json.js';
import type { DoctorCheck, DoctorContext } from '../../src/contracts/index.js';

const nativeReport = () => ({
  checks: [
    {
      name: 'SDK prerequisites',
      status: 'passed',
      detail: 'SDK prerequisites are available.',
    },
  ],
  network: { status: 'passed', probes: [] },
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-doctor-sdk-'));
  const networkConfigPath = join(directory, 'network.yaml');
  await writeFile(networkConfigPath, '{}\n');
  const previous = {
    network: process.env.EVALUATOR_NETWORK_CONFIG,
    key: process.env.DOCTOR_TEST_KEY,
  };
  process.env.EVALUATOR_NETWORK_CONFIG = networkConfigPath;
  process.env.DOCTOR_TEST_KEY = 'evaluator-fixture-key-never-print';
  const registry = new Registry();
  await registerBuiltins(registry);
  t.after(async () => {
    if (previous.network === undefined)
      delete process.env.EVALUATOR_NETWORK_CONFIG;
    else process.env.EVALUATOR_NETWORK_CONFIG = previous.network;
    if (previous.key === undefined) delete process.env.DOCTOR_TEST_KEY;
    else process.env.DOCTOR_TEST_KEY = previous.key;
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const recipe = await Recipe.fromJSON(
    {
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-sdk-fixture',
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
        config: { dataset: { taskIds: ['fixture-task'] } },
      },
      bindings: {
        evaluator: { plugin: 'evaluator.agentbench', config: agentConfig() },
      },
    },
    registry,
    { sourcePath: join(directory, 'recipe.json') },
  );
  const context = (config: JsonObject, pluginId = 'evaluator.agentbench') => {
    const checks: DoctorCheck[] = [];
    const ctx: Omit<DoctorContext, 'recipe' | 'directory' | 'signal'> & {
      recipe: Recipe;
      directory: string;
      signal: AbortSignal;
    } = {
      binding: {
        name: 'evaluator',
        pluginId,
        config,
        definition: registry.get(pluginId),
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
            ...(options?.reason ? { reason: options.reason } : {}),
            ...(options?.details ? { details: options.details } : {}),
          });
          return true;
        } catch (error) {
          ctx.signal.throwIfAborted();
          checks.push({
            id,
            status: 'failed',
            reason:
              options?.reason ||
              (error instanceof Error ? error.message : String(error)),
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
      missing() {
        throw new Error(
          'SDK results must not fabricate RSI missing-resource dependencies',
        );
      },
    };
    return { ctx, checks };
  };
  return { directory, registry, recipe, context, networkConfigPath };
}

function agentConfig(): JsonObject {
  return {
    benchmark: 'workbuddy',
    services: {
      default: {
        model: 'evaluation-model',
        base_url: 'http://evaluation.example/v1',
        api_key: '${DOCTOR_TEST_KEY}',
      },
    },
    run: { sampling: { count: 1 }, offset: 3 },
  };
}

test('agentbench delegates effective task and service configuration to SDK doctor without host probes', async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('RSI must not probe evaluator services');
  });
  const { ctx, checks } = f.context(agentConfig());
  let calls = 0;
  const runner: SdkDoctorRunner = async (options) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    assert.equal(await readFile(options.networkConfigPath, 'utf8'), '{}\n');
    assert.equal(
      options.env.DOCTOR_TEST_KEY,
      'evaluator-fixture-key-never-print',
    );
    const config = object(
      JSON.parse(await readFile(options.configPath, 'utf8')),
    );
    const benchmark = object(config.benchmark);
    const solver = object(benchmark.solver);
    assert.equal(solver.name, 'agentbundle');
    assert.equal(
      object(solver.config).path,
      object(f.recipe.application.config.baseline).directory,
    );
    assert.deepEqual(object(config.run).taskIds, ['fixture-task']);
    assert.equal(object(config.run).maxTasks, null);
    assert.equal(object(config.run).sampling, undefined);
    assert.equal(object(config.run).offset, undefined);
    assert.ok(String(object(config.output).directory).startsWith(f.directory));
    assert.deepEqual(
      object(config.services).default,
      object(agentConfig().services).default,
    );
    return nativeReport();
  };
  await createAgentbenchDoctor(runner)(ctx);
  assert.equal(calls, 1);
  assert.equal(
    checks.find((check) => check.id === 'configuration')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'sdk-doctor')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'sdk.check-0')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'sdk.network')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.id === 'model-access')?.status,
    'unchecked',
  );
  assert.equal(
    checks.find((check) => check.id === 'docker-disk-capacity')?.status,
    'unchecked',
  );
  assert.ok(
    !checks.some(
      (check) =>
        check.id === 'gateway-model-access' || check.id === 'docker-disk-space',
    ),
  );
});

test('SDK diagnostics preserve failures, unsupported checks and incomplete network evidence', async (t) => {
  const f = await fixture(t);
  const { ctx, checks } = f.context(agentConfig());
  await createAgentbenchDoctor(async () => ({
    checks: [
      {
        name: 'Model credentials',
        status: 'failed',
        detail: 'Evaluation service rejected its API key.',
      },
      {
        name: 'Disk capacity',
        status: 'not-checked',
        detail: 'SDK cannot locate the execution-node image store.',
      },
    ],
    network: {
      status: 'incomplete',
      probes: [
        {
          name: 'runtime model route',
          status: 'not-checked',
          evidence: 'remote node unavailable',
          observed: { route: 'runtime' },
        },
      ],
    },
  }))(ctx);
  assert.equal(
    checks.find((check) => check.id === 'sdk.check-0')?.status,
    'failed',
  );
  assert.match(
    checks.find((check) => check.id === 'sdk.check-0')?.reason ?? '',
    /rejected its API key/,
  );
  assert.equal(
    checks.find((check) => check.id === 'sdk.check-1')?.status,
    'unchecked',
  );
  const network = checks.find((check) => check.id === 'sdk.network');
  assert.equal(network?.status, 'unchecked');
  assert.match(JSON.stringify(network?.details), /remote node unavailable/);
});

test('relative SDK network configuration follows the launch directory rather than probe storage', async (t) => {
  const f = await fixture(t);
  const { ctx, checks } = f.context(agentConfig());
  ctx.directory = join(f.directory, 'probe');
  await mkdir(ctx.directory);
  const originalDirectory = process.cwd();
  const previousNetwork = process.env.EVALUATOR_NETWORK_CONFIG;
  let calls = 0;
  try {
    process.chdir(f.directory);
    process.env.EVALUATOR_NETWORK_CONFIG = 'network.yaml';
    await createAgentbenchDoctor(async (options) => {
      calls++;
      assert.equal(
        options.networkConfigPath,
        join(f.directory, 'network.yaml'),
      );
      assert.equal(options.configPath, join(ctx.directory, 'evaluator.json'));
      assert.equal(await readFile(options.networkConfigPath, 'utf8'), '{}\n');
      return nativeReport();
    })(ctx);
  } finally {
    process.chdir(originalDirectory);
    if (previousNetwork === undefined)
      delete process.env.EVALUATOR_NETWORK_CONFIG;
    else process.env.EVALUATOR_NETWORK_CONFIG = previousNetwork;
  }
  assert.equal(calls, 1);
  assert.equal(
    checks.find((check) => check.id === 'sdk-doctor')?.status,
    'passed',
  );
});

test('SDK transport errors fail delegation without inventing component readiness', async (t) => {
  const f = await fixture(t);
  const { ctx, checks } = f.context(agentConfig());
  await createAgentbenchDoctor(async () => {
    throw new Error('SDK subprocess could not complete');
  })(ctx);
  assert.equal(
    checks.find((check) => check.id === 'sdk-doctor')?.status,
    'failed',
  );
  assert.ok(!checks.some((check) => check.id.startsWith('sdk.check-')));
});

test('invalid SDK reports fail instead of producing successful readiness', async (t) => {
  const f = await fixture(t);
  for (const report of [
    null,
    {},
    {
      checks: [{ name: 'broken', status: 'healthy', detail: 'invalid' }],
      network: { status: 'passed', probes: [] },
    },
    { checks: [], network: { status: 'healthy', probes: [] } },
    ...['failed', 'not-checked'].map((status) => ({
      checks: nativeReport().checks,
      network: {
        status: 'passed',
        probes: [
          {
            name: 'runtime model route',
            status,
            evidence: 'Runtime route was not established.',
          },
        ],
      },
    })),
  ]) {
    const { ctx, checks } = f.context(agentConfig());
    await createAgentbenchDoctor(async () => report)(ctx);
    assert.ok(
      checks.some((check) => check.status === 'failed'),
      JSON.stringify(checks),
    );
    assert.ok(
      !checks.some(
        (check) =>
          check.id.startsWith('sdk.check-') && check.status === 'passed',
      ),
    );
  }
});

test('cancelling evaluator doctor reaches the SDK boundary and propagates interruption', async (t) => {
  const f = await fixture(t);
  const { ctx } = f.context(agentConfig());
  const controller = new AbortController();
  ctx.signal = controller.signal;
  let observed: AbortSignal | undefined;
  const task = createAgentbenchDoctor(async (options) => {
    observed = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason),
        { once: true },
      );
      controller.abort(new Error('Interrupted'));
    });
  })(ctx);
  await assert.rejects(task, /Interrupted/);
  assert.equal(observed?.aborted, true);
});

test('agentbench rejects Application-owned solver and output overrides before SDK invocation', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const invalidConfigs: JsonObject[] = [
    {
      ...agentConfig(),
      benchmark: { name: 'workbuddy', solver: { name: 'other-solver' } },
    },
    {
      ...agentConfig(),
      benchmark: {
        name: 'workbuddy',
        solver: { name: 'agentbundle', config: { path: '/unowned' } },
      },
    },
    { ...agentConfig(), output: { directory: '/unowned' } },
  ];
  for (const config of invalidConfigs) {
    const { ctx, checks } = f.context(config);
    await createAgentbenchDoctor(async () => {
      calls++;
      return nativeReport();
    })(ctx);
    assert.equal(
      checks.find((check) => check.id === 'configuration')?.status,
      'failed',
    );
  }
  assert.equal(calls, 0);
});

test('inferencebench delegates SDK configuration while the future Application endpoint remains unchecked', async (t) => {
  const f = await fixture(t);
  const data = f.recipe.toJSON();
  data.application = {
    plugin: 'application.inference',
    config: {
      target: { schema: resolve('examples/harness/dsh-harness2/target.yaml') },
      baseline: { directory: f.directory },
      start: { argv: [process.execPath] },
      endpoint: { model: 'application-model' },
    },
  };
  const recipe = await Recipe.fromJSON(data, f.registry, {
    sourcePath: join(f.directory, 'recipe.json'),
  });
  const { ctx, checks } = f.context(
    { benchmark: 'agentx', services: { default: {} } },
    'evaluator.inferencebench',
  );
  ctx.recipe = recipe;
  let calls = 0;
  await createInferencebenchDoctor(async (options) => {
    calls++;
    const config = object(
      JSON.parse(await readFile(options.configPath, 'utf8')),
    );
    const service = object(object(config.services).default);
    assert.equal(service.model, 'application-model');
    assert.equal(service.base_url, 'http://127.0.0.1:1');
    return nativeReport();
  })(ctx);
  assert.equal(calls, 1);
  assert.equal(
    checks.find((check) => check.id === 'inference-endpoint')?.status,
    'unchecked',
  );
});

test('inferencebench rejects service fields owned by its Application before SDK invocation', async (t) => {
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
    sourcePath: join(f.directory, 'recipe.json'),
  });
  let calls = 0;
  const invalidServices: JsonObject[] = [
    { alternate: {} },
    { default: { model: 'external' } },
  ];
  for (const services of invalidServices) {
    const { ctx, checks } = f.context(
      { benchmark: 'agentx', services },
      'evaluator.inferencebench',
    );
    ctx.recipe = recipe;
    await createInferencebenchDoctor(async () => {
      calls++;
      return nativeReport();
    })(ctx);
    assert.equal(
      checks.find((check) => check.id === 'configuration')?.status,
      'failed',
    );
  }
  assert.equal(calls, 0);
});

test('operatorbench delegates first-case SDK assessment configuration and rejects invalid task identities', async (t) => {
  const f = await fixture(t);
  const source = resolve('examples/artifacts/kernel/transpose-copy/task');
  for (const name of ['task.json', 'problem.py', 'test.py'])
    await writeFile(
      join(f.directory, name),
      await readFile(join(source, name)),
    );
  const config = { task: { directory: f.directory }, benchmark: 'kernel' };
  const positive = f.context(config, 'evaluator.operatorbench');
  let calls = 0;
  await createOperatorbenchDoctor(async (options) => {
    calls++;
    const prepared = object(
      JSON.parse(await readFile(options.configPath, 'utf8')),
    );
    assert.equal(object(prepared.benchmark).name, 'kernel');
    assert.equal(
      object(object(prepared.benchmark).config).operation,
      'evaluate',
    );
    const selected = object(prepared.run).taskIds;
    assert.ok(Array.isArray(selected));
    assert.equal(selected.length, 1);
    assert.ok(
      String(object(object(prepared.benchmark).config).manifest).startsWith(
        f.directory,
      ),
    );
    return nativeReport();
  })(positive.ctx);
  assert.equal(calls, 1);
  assert.equal(
    positive.checks.find((check) => check.id === 'sdk-doctor')?.status,
    'passed',
  );
  const path = join(f.directory, 'task.json');
  const definition = object(JSON.parse(await readFile(path, 'utf8')));
  assert.ok(Array.isArray(definition.cases));
  definition.cases.push(definition.cases[0]);
  await writeFile(path, JSON.stringify(definition));
  const broken = f.context(config, 'evaluator.operatorbench');
  await createOperatorbenchDoctor(async () => {
    calls++;
    return nativeReport();
  })(broken.ctx);
  assert.equal(
    broken.checks.find((check) => check.id === 'configuration')?.status,
    'failed',
  );
  assert.equal(calls, 1);
});
