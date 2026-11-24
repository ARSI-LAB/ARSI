import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommanderError } from 'commander';
import type { FactStore } from '../../src/contracts/index.js';
import {
  runCommand,
  type CommandContext,
} from '../../src/entries/cli/commands.js';
import type { ProgressStream } from '../../src/entries/cli/terminal-renderer.js';
import { cleanupWorkspace } from '../../src/entries/cli/cleanup.js';
import { checkRecipe } from '../../src/runtime/doctor/check-recipe.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { FileFacts } from '../../src/runtime/storage/index.js';
import { object } from '../../src/shared/json.js';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';

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

function commandFixture(
  t: TestContext,
  {
    facts,
    streamOptions,
  }: {
    facts?: FactStore;
    streamOptions?: Partial<Omit<ProgressStream, 'write'>>;
  } = {},
) {
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
  const chunks: string[] = [];
  return {
    manager,
    openRuntime,
    chunks,
    context: {
      signal: new AbortController().signal,
      openRuntime,
      releaseRuntime: disposeRuntime,
      progressStream: {
        isTTY: false,
        columns: 100,
        env: {},
        ...streamOptions,
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
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
  const { manager, context } = commandFixture(t, { facts: store });
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

function captureProgress(
  fixture: Awaited<ReturnType<typeof managerFixture>>,
  streamOptions: Partial<Omit<ProgressStream, 'write'>> = {},
): {
  context: CommandContext;
  output(): string;
  clear(): void;
} {
  const { manager, dispose } = fixture;
  const chunks: string[] = [];
  return {
    output: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
    context: {
      signal: new AbortController().signal,
      async openRuntime() {
        return {
          manager,
          registry: manager.options.registry,
          context: manager.context,
          dispose,
        };
      },
      releaseRuntime: dispose,
      progressStream: {
        isTTY: false,
        columns: 100,
        env: {},
        ...streamOptions,
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
    },
  };
}

test('CLI prints progress during execution and returns the saved result as JSON', async (t) => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const output = {
    candidateRef: 'selected-candidate',
    measurementRef: 'selected-measurement',
  };
  const fixture = await managerFixture(
    async () => {
      enter();
      await proceed;
      return {};
    },
    {
      policy: {
        steps: [
          {
            id: 'search',
            type: 'loop',
            maxIterations: 1,
            steps: [
              { id: 'evaluate', type: 'invoke', use: 'driver', with: {} },
            ],
          },
        ],
        output,
      },
    },
  );
  t.after(fixture.dispose);
  const { context, output: captured, clear } = captureProgress(fixture);
  const args = [
    'run',
    join(fixture.manager.rootDirectory, 'recipe.yaml'),
    '--progress',
    '--id',
    'progress-run',
  ];

  const pending = runCommand(args, context);
  try {
    await Promise.race([
      entered,
      pending.then(() => assert.fail('Run ended before the call started')),
    ]);
    assert.match(captured(), /Loading Runtime and Recipe/);
    assert.match(captured(), /Running driver \(steps\/search\/.*\/evaluate\)/);
    assert.doesNotMatch(captured(), /Experiment progress-run succeeded/);
  } finally {
    release();
  }

  const command = await pending;
  assert.equal(command.exitCode, 0);
  const result = JSON.parse(command.stdout ?? '');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, output);
  assert.doesNotMatch(captured(), /Completed step /);
  assert.match(captured(), /Completed round 1 \(steps\/search\)/);
  assert.match(captured(), /Experiment progress-run succeeded/);
  assert.match(captured(), /Usage operations=2/);
  assert.match(
    captured(),
    /Result candidate=selected-candidate measurement=selected-measurement/,
  );

  clear();
  const resumed = await runCommand([...args, '--resume'], context);
  assert.deepEqual(JSON.parse(resumed.stdout ?? ''), result);
  assert.match(
    captured(),
    /Experiment progress-run succeeded \(saved result\)/,
  );
  assert.doesNotMatch(captured(), /Running driver/);
});

test('CLI auto-enables sticky TTY progress and honors --quiet, --no-progress, and --verbose', async (t) => {
  const ttyFixture = commandFixture(t, {
    streamOptions: { isTTY: true, env: { NO_COLOR: '1' } },
  });
  const ttyRun = t.mock.method(ttyFixture.manager, 'run', async () => ({
    status: 'ok',
  }));

  await runCommand(['run', 'recipe.yaml'], ttyFixture.context);
  assert.equal(
    typeof ttyRun.mock.calls[0].arguments[1]?.onProgress,
    'function',
  );
  assert.match(ttyFixture.chunks.join(''), /Starting\s+recipe\.yaml/);

  ttyFixture.chunks.length = 0;
  await runCommand(['run', 'recipe.yaml', '--quiet'], ttyFixture.context);
  assert.equal(ttyRun.mock.calls[1].arguments[1]?.onProgress, undefined);
  assert.equal(ttyFixture.chunks.join(''), '');

  await runCommand(['run', 'recipe.yaml', '--no-progress'], ttyFixture.context);
  assert.equal(ttyRun.mock.calls[2].arguments[1]?.onProgress, undefined);
  assert.equal(ttyFixture.chunks.join(''), '');

  const verboseFixture = await managerFixture(async () => ({}));
  t.after(verboseFixture.dispose);
  const { context, output } = captureProgress(verboseFixture);
  await runCommand(
    [
      'run',
      join(verboseFixture.manager.rootDirectory, 'recipe.yaml'),
      '--id',
      'verbose-run',
      '--verbose',
    ],
    context,
  );
  assert.match(output(), /Completed step steps\/drive/);
});

test('CLI reports a saved budget stop and the progress of a subsequent resume', async (t) => {
  let exceedBudget = true;
  const fixture = await managerFixture(async (context) => {
    if (exceedBudget) await context.charge('operations', 100);
    return {};
  });
  t.after(fixture.dispose);
  const { context, output: captured, clear } = captureProgress(fixture);
  const args = [
    'run',
    join(fixture.manager.rootDirectory, 'recipe.yaml'),
    '--progress',
    '--id',
    'retry-run',
  ];

  await assert.rejects(
    runCommand(args, context),
    /Budget exceeded: operations/,
  );
  assert.equal((await fixture.manager.get('retry-run')).status, 'failed');
  assert.match(captured(), /error: Budget exceeded: operations/);
  assert.match(captured(), /Experiment retry-run failed/);
  assert.match(captured(), /Stop reason budget-exhausted \(operations\)/);

  exceedBudget = false;
  clear();
  const resumed = await runCommand([...args, '--resume'], context);
  assert.equal(JSON.parse(resumed.stdout ?? '').status, 'succeeded');
  assert.match(
    captured(),
    /Reused 1 completed call \(_application \(initialize\)\)/,
  );
  assert.match(captured(), /Prior usage /);
  assert.match(captured(), /Running driver \(steps\/drive\)/);
  assert.doesNotMatch(captured(), /Running _application \(initialize\)/);
});

test('CLI doctor prints progress to stderr and keeps JSON report on stdout', async (t) => {
  const fixture = await managerFixture(
    async () => assert.fail('Doctor must not execute the Policy'),
    {
      driverEvents(events) {
        events.on('rsi/doctor', ({ runtime }) => {
          runtime.reportProgress?.({ detail: 'probing fixture' });
          return { checks: [{ id: 'probe', status: 'passed' }] };
        });
      },
    },
  );
  t.after(fixture.dispose);
  const { context, output } = captureProgress(fixture);
  const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');

  const res = await runCommand(
    ['doctor', recipe, '--progress', '--verbose'],
    context,
  );
  assert.equal(res.exitCode, 0);
  const report = JSON.parse(res.stdout ?? '');
  assert.equal(report.summary.failed, 0);
  assert.match(output(), /Checking Recipe /);
  assert.match(output(), /Validated Recipe /);
  assert.match(output(), /driver: probing fixture[\s\S]*passed: driver\.probe/);
  assert.match(output(), /Summary \d+ passed · 0 failed/);

  const fixture2 = await managerFixture(async () => ({}));
  t.after(fixture2.dispose);
  const tty = captureProgress(fixture2, {
    isTTY: true,
    env: { NO_COLOR: '1' },
  });
  const quiet = await runCommand(
    [
      'doctor',
      join(fixture2.manager.rootDirectory, 'recipe.yaml'),
      '--static',
      '--quiet',
    ],
    tty.context,
  );
  assert.equal(quiet.exitCode, 0);
  assert.equal(tty.output(), '');
});

test('CLI cleanup prints progress to stderr and keeps JSON report on stdout', async (t) => {
  const fixture = await managerFixture(async () => ({}), {
    driverEvents(events) {
      events.on('rsi/cleanup', (request, runtime) => {
        runtime.reportProgress?.({ detail: 'cleaning fixture receipt 1/1' });
        return [
          {
            key: 'call-fixture',
            status: request.dryRun ? 'preview' : 'complete',
          },
        ];
      });
    },
  });
  t.after(fixture.dispose);

  await fixture.manager.run(
    join(fixture.manager.rootDirectory, 'recipe.yaml'),
    { id: 'cleanup-exp' },
  );

  const plain = captureProgress(fixture);
  const single = await runCommand(
    ['cleanup', 'cleanup-exp', '--dry-run', '--progress', '--verbose'],
    plain.context,
  );
  assert.equal(single.exitCode, 0);
  const singleJson = JSON.parse(single.stdout ?? '');
  assert.equal(singleJson.experimentId, 'cleanup-exp');
  assert.equal(singleJson.dryRun, true);
  assert.equal(singleJson.results.length, 1);
  assert.match(plain.output(), /Previewing experiment cleanup-exp \(dry-run\)/);
  assert.match(plain.output(), /driver: cleaning fixture receipt 1\/1/);
  assert.match(plain.output(), /Preview driver \(test\.driver\)/);
  assert.match(plain.output(), /Summary preview · 1 receipt/);

  plain.clear();
  const ws = await runCommand(['cleanup', '--progress'], plain.context);
  assert.equal(ws.exitCode, 0);
  const wsJson = JSON.parse(ws.stdout ?? '');
  assert.equal(wsJson.dryRun, true);
  assert.equal(wsJson.experiments.length, 1);
  assert.match(plain.output(), /Previewing workspace \(dry-run\)/);
  assert.match(plain.output(), /Found 1 experiment in workspace/);
  assert.match(plain.output(), /Preview cleanup-exp/);
  assert.match(plain.output(), /Summary 1 experiment \(1 preview\)/);

  const tty = captureProgress(fixture, {
    isTTY: true,
    env: { NO_COLOR: '1' },
  });
  const quiet = await runCommand(
    ['cleanup', 'cleanup-exp', '--dry-run', '--quiet'],
    tty.context,
  );
  assert.equal(quiet.exitCode, 0);
  assert.equal(tty.output(), '');
});

test(
  'a closed stderr pipe leaves cleanup JSON and exit code intact',
  { timeout: 15000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/entries/cli/main.ts'),
        'cleanup',
        '--dry-run',
        '--progress-mode',
        'plain',
      ],
      {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    child.stderr.destroy();
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { dryRun: true, experiments: [] });
  },
);

test('doctor and cleanup reports are independent of progress observers', async (t) => {
  const f = await managerFixture(async () => ({}), {
    driverEvents(events) {
      events.on('rsi/doctor', () => ({
        checks: [{ id: 'probe', status: 'failed' }],
      }));
      events.on('rsi/cleanup', () => [{ key: 'receipt', status: 'pending' }]);
    },
  });
  t.after(f.dispose);
  const { context } = captureProgress(f);
  const { signal } = context;
  const report = await checkRecipe(
    join(f.manager.rootDirectory, 'recipe.yaml'),
    {
      signal,
      staticOnly: false,
      openRuntime: () => context.openRuntime([]),
      releaseRuntime: async () => {},
      onProgress(event) {
        if (event.kind === 'binding-completed') {
          const check = event.checks.find(({ id }) => id === 'driver.probe');
          if (check) check.status = 'passed';
        }
        if (event.kind === 'finished') event.report.summary.failed = 0;
      },
    },
  );
  assert.equal(report.summary.failed, 1);
  assert.equal(
    report.checks.find(({ id }) => id === 'driver.probe')?.status,
    'failed',
  );

  await f.run();
  const workspace = await cleanupWorkspace(f.manager, true, signal, (event) => {
    if (event.kind === 'binding-completed') {
      for (const result of event.results) result.status = 'complete';
    }
    if (event.kind === 'experiment-completed')
      Object.assign(event.entry, { status: 'complete' });
    if (event.kind === 'finished' && event.scope === 'workspace')
      event.report.experiments.length = 0;
  });
  assert.equal(workspace.experiments[0]?.status, 'pending');
  assert.equal(workspace.experiments[0]?.results[0]?.status, 'pending');
});

test('run progress summarizes the Measurement returned by the call', async (t) => {
  let returnedRef = '';
  const f = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    returnedRef = await context.recordMeasurement(measurement);
    const other = structuredClone(measurement);
    object(object(object(other.metrics).score).value).value = 0.42;
    const otherRef = await context.recordMeasurement(other);
    assert.notEqual(otherRef, returnedRef);
    return { measurementRef: returnedRef };
  });
  t.after(f.dispose);
  const { context, output } = captureProgress(f);
  const result = await runCommand(
    ['run', join(f.manager.rootDirectory, 'recipe.yaml'), '--progress'],
    context,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(
    JSON.parse(result.stdout ?? '').output.measurementRef,
    returnedRef,
  );
  assert.match(output(), /score=0.75/);
  assert.doesNotMatch(output(), /score=0.42/);
});

test('cleanup cancellation during discovery keeps partial JSON and labels the summary', async (t) => {
  const { manager, context, chunks } = commandFixture(t);
  const controller = new AbortController();
  assert.ok(manager.facts instanceof FileFacts);
  t.mock.method(manager.facts, 'listIds', async () => {
    controller.abort();
    return [];
  });
  const result = await runCommand(['cleanup', '--progress'], {
    ...context,
    signal: controller.signal,
  });
  assert.equal(result.exitCode, 130);
  assert.deepEqual(JSON.parse(result.stdout ?? ''), {
    dryRun: true,
    experiments: [],
  });
  assert.match(chunks.join(''), /Cancelled 0 experiments/);
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
  ]) {
    const result = launch(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage: arsi/);
    if (args.length === 0) assert.match(result.stdout, /Run facts are saved/);
    if (args.includes('run')) {
      assert.match(result.stdout, /--resume/);
      assert.match(result.stdout, /--progress/);
    }
    if (args.includes('doctor')) {
      assert.match(result.stdout, /--static/);
      assert.match(result.stdout, /--progress/);
    }
    if (args.includes('cleanup')) {
      assert.match(result.stdout, /--dry-run/);
      assert.match(result.stdout, /--all/);
      assert.match(result.stdout, /--progress/);
      assert.match(result.stdout, /previews the workspace/);
    }
    if (args.includes('apply')) assert.match(result.stdout, /revisionID/);
  }
});

test('CLI reports invalid input and focused help to stderr before runtime initialization', () => {
  for (const [args, message, command = ''] of [
    [['run'], /missing required argument/, ' run'],
    [['cleanup', 'id', '--all'], /cannot be combined/, ' cleanup'],
    [['cleanup', '--all', 'id', '--dry-run'], /cannot be combined/, ' cleanup'],
    [['cleanup', 'id', 'other'], /too many arguments/, ' cleanup'],
    [['cleanup', '--progress-mode', 'bad'], /allowed choices/i, ' cleanup'],
    [['cleanup', '--quiet', '--progress'], /cannot be combined/, ' cleanup'],
    [['run', 'r', '--resume'], /requires --id/, ' run'],
    [['run', 'r', '--id', 'run', '--retry'], /unknown option/, ' run'],
    [['run', 'r', '--progress-mode', 'bad'], /allowed choices/i, ' run'],
    [['run', 'r', '--quiet', '--progress'], /cannot be combined/, ' run'],
    [['run', 'r', '--no-progress', '--verbose'], /cannot be combined/, ' run'],
    [['doctor', 'r', '--progress-mode', 'bad'], /allowed choices/i, ' doctor'],
    [['doctor', 'r', '--quiet', '--progress'], /cannot be combined/, ' doctor'],
    [['show', 'id', 'extra'], /too many arguments/, ' show'],
    [['catalog', '--bad'], /unknown option/, ' catalog'],
    [['list', 'bad'], /allowed choices/i, ' list'],
    [['reflection', 'apply'], /missing required argument/, ' reflection apply'],
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
