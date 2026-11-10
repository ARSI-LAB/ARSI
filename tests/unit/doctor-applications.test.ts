import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { Policy } from '../../src/runtime/policy/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { applicationChecks } from '../../src/runtime/doctor/application-checks.js';
import type {
  DoctorCheck,
  DoctorContext,
  MissingResource,
} from '../../src/runtime/doctor/types.js';

const target = (path: string): JsonObject => ({
  schemaVersion: 'rsi.target/v1',
  id: 'doctor-fixture',
  entries: [
    { path, kind: 'file', description: 'Editable source', changes: ['modify'] },
  ],
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-doctor-applications-'));
  const baseline = join(root, 'baseline');
  await mkdir(baseline);
  await writeFile(
    join(baseline, 'input.py'),
    'def kernel_function(x):\n    return x\n',
  );
  const registry = new Registry();
  await registerBuiltins(registry);
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const facts = new FileFacts(join(root, 'facts'));
  const workspaces = new FileWorkspaces(join(root, 'workspaces'), artifacts);
  const controller = new AbortController();
  const runtime = new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: root,
    artifacts,
    facts,
    workspaces,
    signal: controller.signal,
    cleanup: new AbortController().signal,
    experimentId: 'doctor',
    callId: 'doctor',
    bindingId: 'probe',
    directory: root,
  });
  const config = {
    target: { schema: target('input.py') },
    baseline: { directory: baseline },
  };
  const policy = new Policy({
    schemaVersion: 'rsi.policy/v1',
    id: 'doctor.fixture',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    steps: [],
    output: {},
  });
  const recipe = await Recipe.fromJSON(
    {
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-fixture',
      application: { plugin: 'application.kernel', config },
      policy: { id: policy.id },
    },
    registry,
    { sourcePath: join(root, 'recipe.yaml'), policy },
  );
  const run = async (
    pluginId: string,
    settings: JsonObject,
    timeoutMs?: number,
  ) => {
    const checks: DoctorCheck[] = [];
    const missingResources: MissingResource[] = [];
    const context: DoctorContext = {
      binding: {
        name: 'probe',
        pluginId,
        config: settings,
        definition: registry.get(pluginId),
      },
      recipe,
      registry,
      runtime,
      directory: root,
      signal: controller.signal,
      async check(id, action) {
        const deadline = new AbortController();
        const signal = AbortSignal.any([controller.signal, deadline.signal]);
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(
                () => deadline.abort(new Error('probe timed out')),
                timeoutMs,
              );
        try {
          await action(signal);
          checks.push({ id, status: 'passed' });
          return true;
        } catch (error) {
          checks.push({
            id,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
          return false;
        } finally {
          clearTimeout(timer);
        }
      },
      unchecked(id, reason) {
        checks.push({ id, status: 'unchecked', reason });
      },
      missing(resource) {
        missingResources.push({ ...resource, binding: 'probe', pluginId });
      },
    };
    await applicationChecks[pluginId](context);
    return { checks, missingResources };
  };
  return { root, baseline, config, runtime, controller, run };
}

test('doctor verifies kernel source, releases instances, and rejects a missing structural entry', async (t) => {
  const { baseline, config, runtime, run } = await fixture(t);
  const working = await run('application.kernel', config);
  assert.ok(working.checks.every((check) => check.status === 'passed'));
  assert.equal(
    working.checks.find((check) => check.id === 'acquire-instance')?.status,
    'passed',
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
  assert.deepEqual(await runtime.facts.list('experiments'), []);
  assert.deepEqual(await runtime.facts.list('measurements'), []);
  await writeFile(
    join(baseline, 'input.py'),
    'def wrong_entry(x):\n    return x\n',
  );
  const broken = await run('application.kernel', config);
  assert.match(
    broken.checks.find((check) => check.id === 'verify-source')?.reason ?? '',
    /kernel_function/,
  );
  assert.equal(
    broken.checks.find((check) => check.id === 'acquire-instance')?.status,
    'unchecked',
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
});

test('doctor verifies bundle lifecycle and links missing Target input to checks not run', async (t) => {
  const { baseline, runtime, run } = await fixture(t);
  await writeFile(join(baseline, 'workflow.yaml'), 'app: {}\nworkflow: {}\n');
  await writeFile(
    join(baseline, 'bundle.yaml'),
    [
      'schemaVersion: 1',
      'name: doctor-fixture',
      'kind: dify-agent-bundle',
      'harness: { name: dify, version: "*" }',
      'entry: workflow.yaml',
    ].join('\n'),
  );
  await writeFile(join(baseline, 'dependencies.lock'), '{}\n');
  const config = {
    target: { schema: target('workflow.yaml') },
    baseline: { directory: baseline },
  };
  const working = await run('application.agentbundle', config);
  assert.ok(
    working.checks.every((check) => check.status === 'passed'),
    JSON.stringify(working),
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
  await rm(join(baseline, 'workflow.yaml'));
  const absent = await run('application.agentbundle', config);
  assert.equal(
    absent.checks.find((check) => check.id === 'baseline')?.status,
    'failed',
  );
  assert.equal(
    absent.checks.find((check) => check.id === 'verify-bundle')?.status,
    'unchecked',
  );
  assert.deepEqual(absent.missingResources[0].checksNotRun, [
    'verify-bundle',
    'acquire-instance',
  ]);
  assert.equal(
    absent.missingResources[0].reference,
    join(baseline, 'workflow.yaml'),
  );
  await writeFile(join(baseline, 'workflow.yaml'), 'workflow: {}\n');
  await writeFile(join(baseline, 'bundle.yaml'), 'kind: not-a-bundle\n');
  const malformed = await run('application.agentbundle', config);
  assert.equal(
    malformed.checks.find((check) => check.id === 'verify-bundle')?.status,
    'failed',
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
});

test('doctor checks local and remote inference launch inputs without starting the service', async (t) => {
  const { root, baseline, config, run } = await fixture(t);
  const local = {
    ...config,
    start: {
      argv: [process.execPath, '-e', 'throw new Error("must not launch")'],
    },
    endpoint: { model: 'fixture' },
  };
  assert.ok(
    (await run('application.inference', local)).checks.every(
      (check) => check.status === 'passed',
    ),
  );
  const brokenLocal = await run('application.inference', {
    ...local,
    start: { argv: ['rsi-doctor-absent-executable'] },
  });
  assert.match(
    brokenLocal.checks.find((check) => check.id === 'launch-prerequisites')
      ?.reason ?? '',
    /Executable is unavailable/,
  );
  const script = join(root, 'control.py');
  await writeFile(script, 'raise Exception("must not execute")\n');
  await writeFile(join(baseline, 'tuning.json'), '{}\n');
  const remote = {
    ...config,
    remote: { script, executable: process.execPath },
    endpoint: { model: 'fixture', origin: 'http://localhost:8080' },
  };
  assert.ok(
    (await run('application.inference', remote)).checks.every(
      (check) => check.status === 'passed',
    ),
  );
  const invalidOrigin = await run('application.inference', {
    ...remote,
    endpoint: { model: 'fixture', origin: 'http://localhost:8080/service' },
  });
  assert.match(
    invalidOrigin.checks.find((check) => check.id === 'launch-prerequisites')
      ?.reason ?? '',
    /endpoint.origin/,
  );
  await rm(join(baseline, 'tuning.json'));
  const brokenRemote = await run('application.inference', remote);
  assert.equal(
    brokenRemote.checks.find((check) => check.id === 'launch-prerequisites')
      ?.status,
    'failed',
  );
  assert.equal(brokenRemote.missingResources[0].field, 'remote.parametersFile');
});

test('doctor resolves Pi model references and token limits without inference or secret output', async (t) => {
  const { run } = await fixture(t);
  const name = 'RSI_DOCTOR_FIXTURE_KEY';
  const previous = process.env[name];
  process.env[name] = 'fixture-secret-never-print';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  const config = {
    model: 'fixture',
    base_url: 'http://localhost:8080/v1',
    api_key: '${RSI_DOCTOR_FIXTURE_KEY}',
    contextWindow: 100,
    maxTokens: 50,
  };
  assert.equal((await run('agent.pi', config)).checks[0].status, 'passed');
  const tooLarge = await run('agent.pi', { ...config, maxTokens: 101 });
  assert.match(
    tooLarge.checks[0].reason ?? '',
    /maxTokens must not exceed contextWindow/,
  );
  delete process.env[name];
  const absent = await run('agent.pi', config);
  assert.match(absent.checks[0].reason ?? '', /RSI_DOCTOR_FIXTURE_KEY/);
  assert.ok(!JSON.stringify(absent).includes('fixture-secret-never-print'));
});

test('doctor executes only the Codex version probe and detects an unavailable executable', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'fake-codex.mjs');
  await writeFile(
    executable,
    'if (process.argv[2] !== "--version") throw new Error("Agent must not start");\nprocess.stdout.write("codex-fixture 1.0\\n");\n',
  );
  assert.equal(
    (await run('agent.codex', { executable })).checks[0].status,
    'passed',
  );
  const absent = await run('agent.codex', {
    executable: join(root, 'missing-codex.exe'),
  });
  assert.equal(absent.checks[0].status, 'failed');
  assert.match(absent.checks[0].reason ?? '', /missing-codex/);
});

test('doctor disposes a cancelled application acquisition and leaves no workspace', async (t) => {
  const { config, runtime, controller, run } = await fixture(t);
  const create = runtime.workspaces.create.bind(runtime.workspaces);
  let calls = 0;
  runtime.workspaces.create = async (...args) => {
    const result = await create(...args);
    if (++calls === 2)
      controller.abort(new Error('cancelled after materialization'));
    return result;
  };
  const result = await run('application.kernel', config);
  assert.match(
    result.checks.find((check) => check.id === 'acquire-instance')?.reason ??
      '',
    /cancelled after materialization/,
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
  assert.ok(
    (await runtime.facts.list('instances')).every(
      (instance) => instance.status === 'released',
    ),
  );
});

test('doctor releases an application lease after its probe deadline while the command remains active', async (t) => {
  const { config, runtime, controller, run } = await fixture(t);
  const create = runtime.workspaces.create.bind(runtime.workspaces);
  let calls = 0;
  runtime.workspaces.create = async (...args) => {
    const result = await create(...args);
    if (++calls === 2) await delay(250);
    return result;
  };
  const result = await run('application.kernel', config, 100);
  assert.match(
    result.checks.find((check) => check.id === 'acquire-instance')?.reason ??
      '',
    /probe timed out/,
  );
  assert.equal(controller.signal.aborted, false);
  assert.equal(
    result.checks.find((check) => check.id === 'cleanup')?.status,
    'passed',
  );
  assert.deepEqual(await readdir(runtime.workspaces.directory), []);
  assert.ok(
    (await runtime.facts.list('instances')).every(
      (instance) => instance.status === 'released',
    ),
  );
});
