import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommanderError } from 'commander';
import type { FactStore } from '../../src/contracts/index.js';
import { runCommand } from '../../src/entries/cli/commands.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

const home = await mkdtemp(join(tmpdir(), 'rsi-cli-commands-'));
after(async () => {
  await rm(home, { recursive: true, force: true });
});

function launch(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      resolve('src/entries/cli/main.ts'),
      ...args,
    ],
    {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 30000,
      killSignal: 'SIGKILL',
    },
  );
  assert.ifError(result.error);
  return result;
}

function commandFixture(t: TestContext, facts?: FactStore) {
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: home, facts });
  const disposeRuntime = async (): Promise<void> => {
    await manager.dispose();
    await registry.dispose();
  };
  const openRuntime = t.mock.fn(async (_pluginDirectories: string[]) => ({
    manager,
    registry,
    context: manager.context,
    dispose: disposeRuntime,
  }));
  t.after(disposeRuntime);
  return {
    manager,
    openRuntime,
    context: {
      signal: new AbortController().signal,
      openRuntime,
      releaseRuntime: disposeRuntime,
    },
  };
}

test('workspace cleanup uses the Manager to list experiments in a custom fact store', async (t) => {
  const experiment = { id: 'saved', status: 'failed' };
  const store = {
    async read(kind: string, id: string) {
      if (kind === 'experiments' && id === experiment.id) return experiment;
      throw Object.assign(new Error('Missing fact'), { code: 'ENOENT' });
    },
    write: async () => assert.fail('No resources were recorded'),
    list: async (kind: string) => (kind === 'experiments' ? [experiment] : []),
    listIds: () => ['store-internal-key'],
  };
  const { manager, context } = commandFixture(t, store);
  const list = t.mock.method(manager, 'list');
  for (const dryRun of [true, false]) {
    const args = dryRun ? ['cleanup'] : ['cleanup', '--all'];
    const result = await runCommand(args, context);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout ?? ''), {
      dryRun,
      experiments: [
        {
          experimentId: 'saved',
          status: dryRun ? 'preview' : 'complete',
          results: [],
        },
      ],
    });
  }
  assert.equal(list.mock.callCount(), 2);
});

test('CLI forwards run options and repeatable global plugin directories', async (t) => {
  const { manager, openRuntime, context } = commandFixture(t);
  const run = t.mock.method(manager, 'run', async () => ({ status: 'ok' }));

  const result = await runCommand(
    [
      '--plugin-dir',
      'a',
      'run',
      'recipe.yaml',
      '--id=experiment',
      '--resume',
      '--plugin-dir',
      'b',
    ],
    context,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout ?? ''), { status: 'ok' });
  assert.deepEqual(openRuntime.mock.calls[0].arguments, [['a', 'b']]);
  assert.deepEqual(run.mock.calls[0].arguments, [
    resolve('recipe.yaml'),
    { id: 'experiment', resume: true, signal: context.signal },
  ]);

  await runCommand(['run', 'recipe.yaml'], context);
  assert.deepEqual(run.mock.calls[1].arguments, [
    resolve('recipe.yaml'),
    { id: undefined, resume: false, signal: context.signal },
  ]);
});

test('CLI preserves errors thrown by command actions', async (t) => {
  const { manager, context } = commandFixture(t);
  const failure = new CommanderError(0, 'fixture.failure', 'Action failed');
  t.mock.method(manager, 'run', async () => {
    throw failure;
  });
  await assert.rejects(runCommand(['run', 'recipe.yaml'], context), (error) => {
    assert.equal(error, failure);
    return true;
  });
});

test('CLI prints command-specific and nested help to stdout', () => {
  for (const args of [
    [],
    ['-h'],
    ['run', '-h'],
    ['doctor', '--help'],
    ['cleanup', '--help'],
    ['reflection', '-h'],
    ['reflection', 'apply', '-h'],
    ['run', '--help'],
    ['help', 'run'],
    ['reflection', 'apply', '--help'],
    ['memory', 'show', '--help'],
  ]) {
    const result = launch(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage: arsi/);
    if (args.length === 0) assert.match(result.stdout, /Run facts are saved/);
    if (args.includes('run')) assert.match(result.stdout, /--resume/);
    if (args.includes('doctor')) {
      assert.doesNotMatch(result.stdout, /--static/);
      assert.match(result.stdout, /--json/);
    }
    if (args.includes('cleanup')) {
      assert.match(result.stdout, /--dry-run/);
      assert.match(result.stdout, /--all/);
      assert.match(result.stdout, /previews the workspace/);
    }
    if (args.includes('memory'))
      assert.match(result.stdout, /--to <directory>/);
    if (args.includes('apply')) assert.match(result.stdout, /revisionID/);
  }
});

test('CLI reports invalid input and focused help to stderr before runtime initialization', () => {
  for (const [args, message, command = ''] of [
    [['run'], /missing required argument/, ' run'],
    [['cleanup', 'id', '--all'], /cannot be combined/, ' cleanup'],
    [['cleanup', '--all', 'id', '--dry-run'], /cannot be combined/, ' cleanup'],
    [['cleanup', 'id', 'other'], /too many arguments/, ' cleanup'],
    [['run', 'r', '--resume'], /requires --id/, ' run'],
    [['run', 'r', '--id', 'run', '--retry'], /unknown option/, ' run'],
    [['doctor', 'r', '--static'], /unknown option '--static'/, ' doctor'],
    [['show', 'id', 'extra'], /too many arguments/, ' show'],
    [['catalog', '--bad'], /unknown option/, ' catalog'],
    [['list', 'bad'], /allowed choices/i, ' list'],
    [['reflection', 'apply'], /missing required argument/, ' reflection apply'],
    [['reflection'], /Usage: arsi reflection/, ' reflection'],
    [['--plugin-dir', 'missing-extension'], /Usage: arsi/],
    [['dashboard', '--port', '0'], /port must be 1\.\.65535/, ' dashboard'],
    [['dashboard', '--port', '65536'], /port must be 1\.\.65535/, ' dashboard'],
    [['--plugin-dir'], /argument missing/],
    [['serve'], /unknown command/],
    [['unknown'], /unknown command/],
    [['validate', 'r.yaml'], /unknown command/],
  ] as const) {
    const result = launch('--plugin-dir', 'missing-extension', ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.ok(result.stderr.includes(`Usage: arsi${command} `), result.stderr);
  }
});

test('CLI dispatches experiment actions and nested reflection actions', async (t) => {
  const { manager, context } = commandFixture(t);
  const cancel = t.mock.method(manager, 'cancel', async () => {});
  t.mock.method(manager, 'get', async (id: string) => ({ experiment: id }));
  t.mock.method(manager, 'list', async () => [{ experiment: 'exp' }]);
  const revisions = manager.reflection();
  t.mock.method(manager, 'reflection', () => revisions);
  t.mock.method(revisions, 'list', async (id?: string) => [
    { id: id ?? 'all' },
  ]);
  t.mock.method(revisions, 'show', async (id: string) => ({ shown: id }));
  t.mock.method(revisions, 'apply', async (id: string) => ({ applied: id }));

  const run = async (...args: string[]): Promise<unknown> => {
    const result = await runCommand(args, context);
    assert.equal(result.exitCode, 0);
    return JSON.parse(result.stdout ?? '');
  };
  const memories = manager.memory();
  t.mock.method(manager, 'memory', () => memories);
  t.mock.method(
    memories,
    'apply',
    async (id: string, options: { to?: string } = {}) => ({ id, ...options }),
  );
  assert.deepEqual(
    await run('memory', 'apply', 'snapshot', '--to', 'destination'),
    { id: 'snapshot', to: 'destination' },
  );
  assert.deepEqual(await run('list'), [{ experiment: 'exp' }]);
  assert.deepEqual(await run('show', 'exp'), { experiment: 'exp' });
  assert.deepEqual(await run('cancel', 'exp'), {
    id: 'exp',
    cancellationRequested: true,
  });
  assert.deepEqual(cancel.mock.calls[0].arguments, ['exp']);
  assert.deepEqual(await run('reflection', 'list'), [{ id: 'all' }]);
  assert.deepEqual(await run('reflection', 'list', ''), [{ id: 'all' }]);
  assert.deepEqual(await run('reflection', 'list', 'exp'), [{ id: 'exp' }]);
  assert.deepEqual(await run('reflection', 'show', 'rev'), { shown: 'rev' });
  assert.deepEqual(await run('reflection', 'apply', 'rev'), { applied: 'rev' });
  await assert.rejects(
    run('reflection', 'apply', ''),
    /Revision ID is required/,
  );
});
