import test, { type TestContext } from 'node:test';
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
import { object } from '../../src/shared/json.js';
import type { DoctorContext } from '../../src/contracts/index.js';

const target = (path: string): JsonObject => ({
  schemaVersion: 'rsi.target/v1',
  id: 'doctor-fixture',
  entries: [
    { path, kind: 'file', description: 'Editable source', changes: ['modify'] },
  ],
});

function shortenDoctorDeadline(t: TestContext, timeoutMs: number): void {
  const schedule = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => schedule(callback, delay === 60000 ? timeoutMs : delay, ...args),
  );
}

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
  const run = async (pluginId: string, settings: JsonObject) => {
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
    };
    return context.binding.definition.doctor!(context);
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
  assert.deepEqual(absent.missingResources?.[0]?.checksNotRun, [
    'verify-bundle',
    'acquire-instance',
  ]);
  assert.equal(
    absent.missingResources?.[0]?.reference,
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
  assert.equal(
    brokenRemote.missingResources?.[0]?.field,
    'remote.parametersFile',
  );
});

test('doctor resolves Pi model references and token limits without inference or secret output', async (t) => {
  const { run } = await fixture(t);
  const requests: {
    url: string;
    method: string;
    authorization: string | null;
  }[] = [];
  let status = 200;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ data: [{ id: 'fixture' }] }), {
        status,
      });
    },
  );
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
  const working = await run('agent.pi', config);
  assert.equal(working.checks[0].status, 'passed');
  assert.equal(
    working.checks.find((check) => check.id === 'model-access')?.status,
    'passed',
  );
  assert.match(
    working.checks.find((check) => check.id === 'model-access')?.reason ?? '',
    /Proposal.*fixture/,
  );
  assert.deepEqual(requests, [
    {
      url: 'http://localhost:8080/v1/models',
      method: 'GET',
      authorization: 'Bearer fixture-secret-never-print',
    },
  ]);
  status = 403;
  const denied = await run('agent.pi', config);
  assert.equal(
    denied.checks.find((check) => check.id === 'model-access')?.status,
    'failed',
  );
  assert.match(
    denied.checks.find((check) => check.id === 'model-access')?.reason ?? '',
    /Proposal.*denied.*API key/,
  );
  const tooLarge = await run('agent.pi', { ...config, maxTokens: 101 });
  assert.match(
    tooLarge.checks[0].reason ?? '',
    /maxTokens must not exceed contextWindow/,
  );
  delete process.env[name];
  const absent = await run('agent.pi', config);
  assert.match(absent.checks[0].reason ?? '', /RSI_DOCTOR_FIXTURE_KEY/);
  assert.ok(!JSON.stringify(absent).includes('fixture-secret-never-print'));
  assert.equal(
    absent.checks.find((check) => check.id === 'model-access')?.status,
    'unchecked',
  );
  assert.equal(
    requests.length,
    2,
    'invalid configuration must not send a model request',
  );
  assert.ok(
    !JSON.stringify([working, denied]).includes('fixture-secret-never-print'),
  );
});

test('doctor invokes native Codex diagnostics with configured model and inherited environment without claiming model discovery', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'fake-codex.mjs');
  const calls = join(root, 'codex-calls.jsonl');
  const report = {
    schemaVersion: 1,
    overallStatus: 'ok',
    checks: {
      'config.load': { status: 'ok' },
      'network.provider_reachability': {
        status: 'ok',
        details: { credentials: 'private-native-store-secret' },
      },
    },
  };
  await writeFile(
    executable,
    `import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd(), marker: existsSync(join(process.cwd(), '.rsi-project')), path: process.env.PATH }) + '\\n');
if (args[0] === '--help') process.stdout.write('Commands:\\n  doctor  Diagnose local health\\n');
else if (args[0] === 'doctor' && args[1] === '--help') process.stdout.write('Options:\\n  --json Emit redacted JSON\\n  --network-only Probe provider connections\\n');
else if (args.includes('doctor') && args.includes('--json')) process.stdout.write(${JSON.stringify(JSON.stringify(report))});
else throw new Error('No model inference or session may start');
`,
  );
  const result = await run('agent.codex', {
    executable,
    model: 'proposal-model',
    thinkingLevel: 'high',
  });
  assert.equal(
    result.checks.find((check) => check.id === 'doctor')?.status,
    'passed',
  );
  assert.match(
    result.checks.find((check) => check.id === 'doctor')?.reason ?? '',
    /reached the configured model service/,
  );
  assert.equal(
    result.checks.find((check) => check.id === 'model-access')?.status,
    'unchecked',
  );
  assert.ok(!JSON.stringify(result).includes('private-native-store-secret'));
  const invocations = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  assert.deepEqual(
    invocations.map((call) => call.args),
    [
      ['--help'],
      ['doctor', '--help'],
      [
        '-c',
        'project_root_markers=[".rsi-project"]',
        '-c',
        'model="proposal-model"',
        '-c',
        'model_reasoning_effort="high"',
        'doctor',
        '--json',
        '--network-only',
      ],
    ],
  );
  assert.ok(invocations.every((call) => call.path === process.env.PATH));
  assert.ok(invocations.slice(0, 2).every((call) => call.cwd === root));
  const directory = invocations[2].cwd;
  assert.equal(typeof directory, 'string');
  assert.ok(
    typeof directory === 'string' &&
      directory.startsWith(join(root, 'codex-doctor-')),
  );
  assert.equal(invocations[2].marker, true);
  if (typeof directory === 'string')
    await assert.rejects(readdir(directory), /ENOENT/);
  const absent = await run('agent.codex', {
    executable: join(root, 'missing-codex.exe'),
  });
  assert.equal(absent.checks[0].status, 'failed');
  assert.match(absent.checks[0].reason ?? '', /missing-codex/);
});

test('doctor never sends an unsupported Codex subcommand that could become a prompt', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'legacy-codex.mjs');
  const calls = join(root, 'legacy-calls.jsonl');
  await writeFile(
    executable,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.length !== 1 || args[0] !== '--help') throw new Error('Must not send a prompt');
process.stdout.write('Commands:\\n  exec  Run Codex\\n');
`,
  );
  const result = await run('agent.codex', { executable });
  assert.equal(
    result.checks.find((check) => check.id === 'doctor')?.status,
    'unchecked',
  );
  assert.equal(
    result.checks.find((check) => check.id === 'model-access')?.status,
    'unchecked',
  );
  assert.equal(await readFile(calls, 'utf8'), '["--help"]\n');
});

test('doctor reports Codex native failures and invalid output without exposing credential-store diagnostics', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'broken-codex.mjs');
  for (const body of [
    `process.stdout.write(JSON.stringify({ schemaVersion: 1, overallStatus: 'error', checks: { 'auth.credentials': { status: 'error', details: { token: 'private-native-store-secret' } } } }));`,
    `process.stdout.write('invalid-json private-native-store-secret');`,
    `process.stderr.write('private-native-store-secret'); process.exitCode = 1;`,
  ]) {
    await writeFile(
      executable,
      `const args = process.argv.slice(2);
if (args[0] === '--help') process.stdout.write('Commands:\\n  doctor  Diagnose local health\\n');
else if (args[1] === '--help') process.stdout.write('Options:\\n  --json Emit report\\n');
else if (args.includes('doctor') && args.includes('--json')) { ${body} }
else throw new Error('Must not run inference');
`,
    );
    const result = await run('agent.codex', { executable });
    assert.equal(
      result.checks.find((check) => check.id === 'doctor')?.status,
      'failed',
    );
    assert.ok(!JSON.stringify(result).includes('private-native-store-secret'));
  }
  await writeFile(
    executable,
    `process.stderr.write('private-native-store-secret'); process.exitCode = 1;`,
  );
  const unavailable = await run('agent.codex', { executable });
  assert.equal(unavailable.checks[0].status, 'failed');
  assert.ok(
    !JSON.stringify(unavailable).includes('private-native-store-secret'),
  );
});

test('doctor does not infer Codex network access from successful local-only diagnostics', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'local-codex.mjs');
  await writeFile(
    executable,
    `const args = process.argv.slice(2);
if (args[0] === '--help') process.stdout.write('Commands:\\n  doctor  Diagnose local health\\n');
else if (args[1] === '--help') process.stdout.write('Options:\\n  --json Emit report\\n');
else process.stdout.write(JSON.stringify({ schemaVersion: 1, overallStatus: 'ok', checks: { 'config.load': { status: 'ok' } } }));
`,
  );
  const result = await run('agent.codex', { executable });
  assert.match(
    result.checks.find((check) => check.id === 'doctor')?.reason ?? '',
    /native health checks/,
  );
  assert.equal(
    result.checks.find((check) => check.id === 'model-access')?.status,
    'unchecked',
  );
});

test('doctor cancels the Codex diagnostic process at its check deadline', async (t) => {
  const { root, run } = await fixture(t);
  const executable = join(root, 'hanging-codex.mjs');
  await writeFile(
    executable,
    `const args = process.argv.slice(2);
if (args[0] === '--help') process.stdout.write('Commands:\\n  doctor  Diagnose local health\\n');
else if (args[1] === '--help') process.stdout.write('Options:\\n  --json Emit report\\n');
else setInterval(() => {}, 1000);
`,
  );
  shortenDoctorDeadline(t, 1000);
  const result = await run('agent.codex', { executable });
  assert.equal(
    result.checks.find((check) => check.id === 'doctor')?.status,
    'failed',
  );
  assert.match(
    result.checks.find((check) => check.id === 'doctor')?.reason ?? '',
    /timed out|cancelled/,
  );
  assert.ok(
    !(await readdir(root)).some((entry) => entry.startsWith('codex-doctor-')),
  );
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
  await assert.rejects(
    run('application.kernel', config),
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
  shortenDoctorDeadline(t, 100);
  const result = await run('application.kernel', config);
  assert.match(
    result.checks.find((check) => check.id === 'acquire-instance')?.reason ??
      '',
    /timed out/i,
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
