import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  RuntimeContext,
  type JsonObject,
  type CleanupContext,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { FileFacts } from '../../src/runtime/storage/index.js';
import { object } from '../../src/shared/json.js';
import {
  runEvaluatorCleanup,
  recordCleanupInput,
} from '../../src/plugins/shared/evaluator-adapter/cleanup.js';
import {
  createAgentbench,
  prepareEvaluationConfig,
} from '../../src/plugins/evaluator-agentbench/service.js';
import { prepareEvaluationConfig as prepareKernelConfig } from '../../src/plugins/evaluator-operatorbench/service.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { managerFixture } from '../helpers/manager-fixture.js';

const agentCleanup = {
  binding: { id: 'agent-evaluator', kind: 'agentbundle' },
} as const;

async function fixture(t: test.TestContext) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'rsi-evaluator-cleanup-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const network = join(dataDirectory, 'network.yaml');
  await writeFile(network, '{}\n');
  for (const [key, value] of Object.entries({
    EVALUATOR_NETWORK_CONFIG: network,
    EVALUATOR_CACHE_DIR: join(dataDirectory, 'cache'),
    DOCKER_HOST: 'tcp://127.0.0.1:1',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const facts = new FileFacts(join(dataDirectory, 'facts'));
  const experimentId = 'cleanup-test';
  const kind = `evaluator-cleanup-${experimentId}`;
  await facts.write('definitions', experimentId, {
    recipe: { application: { plugin: 'application.agentbundle' } },
  });
  const context = new RuntimeContext().extend({
    experimentId,
    bindingId: agentCleanup.binding.id,
    callId: 'call-' + 'a'.repeat(32),
    dataDirectory,
    facts,
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
  });
  async function register(
    attempt?: string,
    workspaceRef: string | null = randomUUID(),
    overrides: JsonObject = {},
    owner = context,
  ) {
    const { callId } = owner;
    const directory = join(
      dataDirectory,
      'experiments',
      experimentId,
      'calls',
      callId,
      ...(attempt ? ['attempts', attempt] : []),
    );
    const idempotencyKey = attempt ? callId + '-' + attempt : callId;
    const call = owner.extend({ directory, idempotencyKey });
    const input = prepareEvaluationConfig(
      {
        benchmark: { name: 'terminalbench', version: '4.0' },
        services: {
          default: {
            model: 'fixture',
            base_url: 'http://localhost:1',
            api_key: '${UNSET_FIXTURE_TOKEN}',
          },
        },
        environment: 'docker',
        ...overrides,
      },
      {
        directory,
        taskIds: ['fixture-task'],
        execution: {
          directory: workspaceRef
            ? join(dataDirectory, 'workspaces', workspaceRef, 'files')
            : dataDirectory,
        },
      },
    );
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'evaluator.json');
    await writeFile(path, JSON.stringify(input));
    await recordCleanupInput(
      { context: call, kind: 'agentbundle', workspaceRef },
      path,
      process.env,
    );
    return { key: idempotencyKey, path };
  }
  return {
    context,
    kind,
    register,
    read: (key: string) => facts.read(kind, key),
  };
}

function report(...statuses: string[]): JsonObject {
  return {
    preview: false,
    nodes: [
      {
        nodeId: 'fixture',
        daemonId: 'fixture',
        items: statuses.map((status) => ({
          reference: 'fixture/' + status,
          imageId: 'fixture-id',
          status,
          reason: 'fixture ' + status,
        })),
      },
    ],
  };
}

async function builtinRegistry(t: test.TestContext): Promise<Registry> {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  return registry;
}

function cleanupContext(ctx: RuntimeContext, pluginId: string): CleanupContext {
  return {
    experimentId: ctx.experimentId,
    bindingId: ctx.bindingId,
    pluginId,
    dryRun: false,
    dataDirectory: ctx.dataDirectory,
    facts: ctx.facts,
    signal: ctx.signal,
  };
}

const agentConfig = { benchmark: 'terminalbench', services: {} };

test('only configured Evaluators look for cleanup inputs, even when their instances never started', async (t) => {
  const f = await managerFixture(async () => ({ done: true }));
  t.after(() => f.dispose());
  await registerBuiltins(f.manager.options.registry);
  const scan = t.mock.method(FileFacts.prototype, 'scan');
  const result = await f.run();
  assert.equal(result.status, 'succeeded');
  const recipePath = join(f.manager.rootDirectory, 'recipe.yaml');
  const saved = await f.manager.run(recipePath, { id: 'test', resume: true });
  assert.deepEqual(saved, result);
  const cleanupScans = () =>
    scan.mock.calls
      .map(({ arguments: [kind] }) => kind)
      .filter((kind) => /^evaluator-(?:cleanup|images)-/.test(kind));
  assert.deepEqual(cleanupScans(), []);
  const policyPath = join(f.manager.rootDirectory, 'policy.yaml');
  const policy = parseDocument(await readFile(policyPath, 'utf8'));
  const recipe = parseDocument(await readFile(recipePath, 'utf8'));
  policy.setIn(['require', 'unused'], { contract: 'contract.agentbench' });
  recipe.setIn(['bindings', 'unused'], {
    plugin: 'evaluator.agentbench',
    config: agentConfig,
  });
  await writeFile(policyPath, policy.toString());
  await writeFile(recipePath, recipe.toString());
  assert.equal(
    (await f.manager.run(recipePath, { id: 'unused' })).status,
    'succeeded',
  );
  assert.deepEqual(cleanupScans(), [
    'evaluator-cleanup-unused',
    'evaluator-images-unused',
  ]);
});

test('disposing an evaluator instance leaves its experiment resources pending', async (t) => {
  const f = await fixture(t);
  const entry = await f.register();
  const evaluator = await createAgentbench(agentConfig, f.context);
  await evaluator.dispose();
  assert.deepEqual((await f.read(entry.key)).attempts, []);
});

test('older receipts require a call identifying the same experiment and binding', async (t) => {
  const f = await fixture(t);
  const entry = await f.register();
  const { bindingId, ...legacy } = await f.read(entry.key);
  assert.equal(bindingId, f.context.bindingId);
  await f.context.facts.write(f.kind, entry.key, legacy);
  const paths: string[] = [];
  const run = async ({ configPath }: { configPath: string }) => {
    paths.push(configPath);
    return report('retained');
  };
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  for (const [experimentId, owner] of [
    ['foreign', f.context.bindingId],
    [f.context.experimentId, 'other'],
  ]) {
    await f.context.facts.write('calls', entry.key, {
      callId: entry.key,
      experimentId,
      bindingId: owner,
    });
    await runEvaluatorCleanup(f.context, agentCleanup, run);
  }
  assert.deepEqual((await f.read(entry.key)).attempts, []);
  const recoveredFrom = entry.key + '-' + 'b'.repeat(24);
  await f.context.facts.write('calls', entry.key, {
    callId: entry.key,
    experimentId: f.context.experimentId,
    bindingId: 'replacement',
    recoveredFrom,
  });
  await f.context.facts.write('call-attempts', recoveredFrom, {
    callId: entry.key,
    experimentId: f.context.experimentId,
    bindingId,
  });
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  assert.deepEqual(paths, [entry.path]);
  assert.equal((await f.read(entry.key)).bindingId, bindingId);
});

test('cleanup preserves per-attempt SDK outcomes and only retries pending inputs', async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  const second = await f.register('b'.repeat(24));
  const paths: string[] = [];
  const partial = report(
    'deleted',
    'retained',
    'skipped',
    'failed',
    'candidate',
  );
  await runEvaluatorCleanup(f.context, agentCleanup, async (options) => {
    assert.equal(options.execute, true);
    paths.push(options.configPath);
    return options.configPath === first.path ? partial : report('retained');
  });
  assert.deepEqual(paths.sort(), [first.path, second.path].sort());
  assert.equal((await f.read(second.key)).status, 'complete');
  const pending = await f.read(first.key);
  assert.equal(pending.status, 'pending');
  assert.ok(Array.isArray(pending.attempts));
  assert.deepEqual(object(pending.attempts[0]).report, partial);
  await runEvaluatorCleanup(f.context, agentCleanup, async (options) => {
    assert.equal(options.configPath, first.path);
    return report('deleted');
  });
  const final = await f.read(first.key);
  assert.equal(final.status, 'complete');
  assert.ok(Array.isArray(final.attempts));
  assert.equal(final.attempts.length, 2);
  await runEvaluatorCleanup(f.context, agentCleanup, async () =>
    assert.fail('completed input was replayed'),
  );
});

test('manual preview reports an unverified receipt and leaves both bindings untouched', async (t) => {
  const f = await fixture(t);
  const owned = await f.register();
  const peer = f.context.extend({
    bindingId: 'peer',
    callId: 'call-' + 'e'.repeat(32),
  });
  const other = await f.register(undefined, randomUUID(), {}, peer);
  const { bindingId, ...unverified } = await f.read(owned.key);
  assert.equal(bindingId, f.context.bindingId);
  await f.context.facts.write(f.kind, owned.key, unverified);
  const before = await f.context.facts.list(f.kind);
  const paths: string[] = [];
  const results = await runEvaluatorCleanup(
    f.context,
    { binding: { id: peer.bindingId, kind: 'agentbundle' }, dryRun: true },
    async (options) => {
      assert.equal(options.execute, false);
      paths.push(options.configPath);
      return { ...report('candidate'), preview: true };
    },
  );
  assert.deepEqual(paths, [other.path]);
  assert.equal(
    results.find((item) => item.key === other.key)?.status,
    'preview',
  );
  const pending = results.find((item) => item.key === owned.key);
  assert.equal(pending?.status, 'pending');
  assert.match(pending?.error ?? '', /identify the binding/);
  assert.deepEqual(await f.context.facts.list(f.kind), before);
});

test('cleanup resumes legacy receipts and processes each call only once across both collections', async (t) => {
  const f = await fixture(t);
  const { dataDirectory, experimentId, facts } = f.context;
  const legacyKind = `evaluator-images-${experimentId}`;
  const older = await f.register();
  await runEvaluatorCleanup(f.context, agentCleanup, async () =>
    report('skipped'),
  );
  const prior = await f.read(older.key);
  await rename(
    join(dataDirectory, 'facts', f.kind),
    join(dataDirectory, 'facts', legacyKind),
  );

  const current = await f.register('b'.repeat(24));
  const duplicate = await f.read(current.key);
  await facts.write(legacyKind, current.key, duplicate);
  const paths: string[] = [];
  const run = async ({ configPath }: { configPath: string }) => {
    paths.push(configPath);
    return report('retained');
  };
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  await runEvaluatorCleanup(f.context, agentCleanup, run);

  assert.deepEqual(paths.sort(), [older.path, current.path].sort());
  const resumed = await facts.read(legacyKind, older.key);
  assert.equal(resumed.status, 'complete');
  assert.ok(Array.isArray(resumed.attempts));
  assert.equal(resumed.attempts.length, 2);
  assert.deepEqual(resumed.attempts.slice(0, 1), prior.attempts);
  assert.equal((await f.read(current.key)).status, 'complete');
  assert.deepEqual(await facts.read(legacyKind, current.key), duplicate);
});

test('uncertain ownership, edited input and an unrelated experiment never invoke cleanup', async (t) => {
  const f = await fixture(t);
  const edited = await f.register();
  const shared = await f.register('c'.repeat(24), null);
  await writeFile(edited.path, '{}');
  const calls: string[] = [];
  const run = async (options: { configPath: string }) => {
    calls.push(options.configPath);
    return report();
  };
  await runEvaluatorCleanup(
    f.context.extend({ experimentId: 'elsewhere' }),
    agentCleanup,
    run,
  );
  assert.deepEqual((await f.read(shared.key)).attempts, []);
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  assert.deepEqual(calls, []);
  assert.match(
    JSON.stringify((await f.read(edited.key)).attempts),
    /input changed/i,
  );
  assert.match(
    JSON.stringify((await f.read(shared.key)).attempts),
    /ownership/i,
  );
});

test('an aborted cleanup or an SDK error stays retryable with a recorded reason', async (t) => {
  const f = await fixture(t);
  const entry = await f.register();
  await runEvaluatorCleanup(
    f.context.extend({
      signal: AbortSignal.abort(new Error('cleanup deadline')),
    }),
    agentCleanup,
  );
  await runEvaluatorCleanup(f.context, agentCleanup, async () => {
    throw new Error('daemon unavailable');
  });
  const controller = new AbortController();
  const partial = report('deleted', 'skipped');
  await runEvaluatorCleanup(
    f.context.extend({ signal: controller.signal }),
    agentCleanup,
    async () => {
      controller.abort(new Error('interrupted after one removal'));
      return partial;
    },
  );
  const receipt = await f.read(entry.key);
  assert.equal(receipt.status, 'pending');
  assert.match(
    JSON.stringify(receipt.attempts),
    /cleanup deadline.*daemon unavailable/,
  );
  assert.ok(Array.isArray(receipt.attempts));
  assert.deepEqual(object(receipt.attempts.at(-1)).report, partial);
});

test('a changed configuration variable does not settle cleanup against a different ownership fingerprint', async (t) => {
  const f = await fixture(t);
  const prior = process.env.RSI_CLEANUP_TEST_IMAGE;
  t.after(() => {
    if (prior === undefined) delete process.env.RSI_CLEANUP_TEST_IMAGE;
    else process.env.RSI_CLEANUP_TEST_IMAGE = prior;
  });
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/original:1';
  const entry = await f.register(undefined, randomUUID(), {
    environment: {
      name: 'docker',
      config: { image: '${RSI_CLEANUP_TEST_IMAGE}' },
    },
  });
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/replacement:1';
  let calls = 0;
  const run = async () => {
    calls++;
    return report();
  };
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  assert.equal(calls, 0);
  assert.equal((await f.read(entry.key)).status, 'pending');
  process.env.RSI_CLEANUP_TEST_IMAGE = 'fixture/original:1';
  await runEvaluatorCleanup(f.context, agentCleanup, run);
  assert.equal(calls, 1);
  assert.equal((await f.read(entry.key)).status, 'complete');
});

test('operator cleanup uses its call-owned kernel manifest and local evaluations create no cleanup receipts', async (t) => {
  const f = await fixture(t);
  await f.register(undefined, randomUUID(), { environment: 'local' });
  assert.deepEqual(await f.context.facts.list(f.kind), []);
  const callId = 'call-' + 'd'.repeat(32);
  const directory = join(
    f.context.dataDirectory,
    'experiments',
    f.context.experimentId,
    'calls',
    callId,
  );
  await mkdir(directory, { recursive: true });
  const context = f.context.extend({
    callId,
    bindingId: 'kernel-evaluator',
    idempotencyKey: callId,
    directory,
  });
  const path = join(directory, 'sdk-config.json');
  const config = prepareKernelConfig(
    { benchmark: 'kernel', environment: 'docker' },
    {
      selected: { id: 'one', seed: 42 },
      operation: 'evaluate',
      directory,
      manifest: join(directory, 'sdk-input', 'manifest.json'),
    },
  );
  await writeFile(path, JSON.stringify(config));
  await recordCleanupInput({ context, kind: 'kernel' }, path, process.env);
  const issued: string[] = [];
  await runEvaluatorCleanup(
    context,
    { binding: { id: context.bindingId, kind: 'agentbundle' } },
    async () => assert.fail('AgentBench consumed a kernel input'),
  );
  assert.deepEqual((await f.read(callId)).attempts, []);
  const registry = await builtinRegistry(t);
  const owner = cleanupContext(context, 'evaluator.operatorbench');
  await registry.dispatch(owner.pluginId, 'rsi/cleanup', {
    ...owner,
    signal: AbortSignal.abort(new Error('operator cleanup deadline')),
  });
  assert.match(
    JSON.stringify((await f.read(callId)).attempts),
    /operator cleanup deadline/,
  );
  await runEvaluatorCleanup(
    context,
    { binding: { id: context.bindingId, kind: 'kernel' } },
    async (options) => {
      issued.push(options.configPath);
      return report('retained');
    },
  );
  assert.deepEqual(issued, [path], JSON.stringify(await f.read(callId)));
  assert.equal((await f.read(callId)).status, 'complete');
});

test('the registered AgentBench handler cleans its binding through the installed SDK without an instance', async (t) => {
  const f = await fixture(t);
  const root = f.context.dataDirectory;
  const docker = join(root, 'docker.cjs');
  const log = join(root, 'commands.txt');
  // Node stands in for the Docker binary. Only the SDK's read-only requests are accepted.
  await writeFile(
    docker,
    `
    const command = require('node:path').basename(process.argv[1] ?? '');
    if (command === 'cli.js') throw new Error('Evaluator cleanup must use the SDK directly');
    if (['info', 'image', 'ps'].includes(command)) {
      const args = [command, ...process.argv.slice(2)].join(' ');
      require('node:fs').appendFileSync(${JSON.stringify(log)}, args + '\\n');
      if (command === 'info') console.log('fixture-daemon');
      process.exit(command === 'image' && process.argv[2] !== 'ls' ? 1 : 0);
    }
  `,
  );
  const entry = await f.register(undefined, randomUUID(), {
    environment: { config: { dockerExecutable: process.execPath } },
  });
  const peer = await f.register(
    undefined,
    randomUUID(),
    {},
    f.context.extend({ bindingId: 'peer', callId: 'call-' + 'e'.repeat(32) }),
  );
  // The SDK starts our Docker substitute directly in the process environment.
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [
    previous,
    '--require=' + JSON.stringify(docker.replaceAll('\\', '/')),
  ]
    .filter(Boolean)
    .join(' ');
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
  const registry = await builtinRegistry(t);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  const owner = cleanupContext(f.context, 'evaluator.agentbench');
  const results = await registry.dispatch(owner.pluginId, 'rsi/cleanup', owner);
  const receipt = await f.read(entry.key);
  assert.equal(receipt.status, 'complete', JSON.stringify(receipt.attempts));
  assert.deepEqual(
    results.map(({ key, status }) => ({ key, status })),
    [{ key: entry.key, status: 'complete' }],
  );
  assert.deepEqual((await f.read(peer.key)).attempts, []);
  assert.match(JSON.stringify(receipt.attempts), /fixture-daemon/);
  const commands = await readFile(log, 'utf8');
  assert.match(commands, /image ls/);
  assert.doesNotMatch(commands, /image rm/);
});
