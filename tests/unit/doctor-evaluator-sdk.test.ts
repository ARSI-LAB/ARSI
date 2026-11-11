import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sdkDoctor,
  type SdkDoctorOptions,
} from '../../src/plugins/shared/evaluator-adapter/doctor-sdk.js';

async function fixture(
  t: test.TestContext,
  script: string,
): Promise<{
  root: string;
  options: SdkDoctorOptions;
  calls: {
    executable: string;
    args: readonly string[];
    options: SpawnOptions;
  }[];
  ready: Promise<ChildProcess>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-sdk-doctor-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, 'sdk-fixture.mjs');
  await writeFile(executable, script);
  const configPath = join(root, 'evaluator.json');
  const networkConfigPath = join(root, 'network.yaml');
  await writeFile(configPath, '{}');
  await writeFile(networkConfigPath, '{}');
  const options = {
    configPath,
    networkConfigPath,
    signal: new AbortController().signal,
    env: { ...process.env, DOCTOR_FIXTURE_KEY: 'fixture-secret-never-print' },
  };
  const calls: {
    executable: string;
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  let ready!: (child: ChildProcess) => void;
  const started = new Promise<ChildProcess>((resolve) => {
    ready = resolve;
  });
  const original = childProcess.spawn;
  t.mock.method(
    childProcess,
    'spawn',
    (command: string, args: readonly string[], settings: SpawnOptions) => {
      calls.push({ executable: command, args: [...args], options: settings });
      const commandArgs = [...args];
      const index = commandArgs.indexOf('doctor') - 1;
      assert.ok(index >= 0);
      commandArgs[index] = executable;
      const child = original(command, commandArgs, settings);
      child.on('message', (message) => {
        if (message === 'ready') ready(child);
      });
      return child;
    },
  );
  return { root, options, calls, ready: started };
}

test('SDK doctor invokes the installed public CLI with isolated configuration and its own environment', async (t) => {
  const f = await fixture(
    t,
    `
    import assert from 'node:assert/strict';
    assert.equal(process.env.DOCTOR_FIXTURE_KEY, 'fixture-secret-never-print');
    process.stdout.write(JSON.stringify({ checks: [{ name: 'configuration', status: 'passed', detail: 'Available' }], network: { status: 'passed', probes: [] } }));
  `,
  );
  const result = await sdkDoctor(f.options);
  assert.deepEqual(result, {
    checks: [{ name: 'configuration', status: 'passed', detail: 'Available' }],
    network: { status: 'passed', probes: [] },
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.executable, process.execPath);
  const cli = join(
    dirname(fileURLToPath(import.meta.resolve('ember-evaluator'))),
    'cli.js',
  );
  await access(cli);
  assert.deepEqual(call.args.slice(2), [
    cli,
    'doctor',
    f.options.configPath,
    '--network',
    f.options.networkConfigPath,
  ]);
  assert.equal(call.options.cwd, f.root);
  assert.equal(call.options.env, f.options.env);
  assert.doesNotMatch(JSON.stringify(call.args), /fixture-secret/);
});

test('SDK diagnostic exit one retains failed and unchecked observations for report adaptation', async (t) => {
  const f = await fixture(
    t,
    `
    process.stdout.write(JSON.stringify({ checks: [{ name: 'runtime', status: 'failed', detail: 'Unavailable' }], network: { status: 'not-checked', probes: [] } }));
    process.exitCode = 1;
  `,
  );
  assert.deepEqual(await sdkDoctor(f.options), {
    checks: [{ name: 'runtime', status: 'failed', detail: 'Unavailable' }],
    network: { status: 'not-checked', probes: [] },
  });
});

test('SDK configuration failure discards raw stdout and stderr credentials', async (t) => {
  const f = await fixture(
    t,
    `
    process.stdout.write('stdout ' + process.env.DOCTOR_FIXTURE_KEY);
    process.stderr.write('services.default.model: missing variable MODEL_NAME; credential=' + process.env.DOCTOR_FIXTURE_KEY + ' alias=' + process.env.DOCTOR_ALIAS + ' https://user:secret-password@example.test/?token=url-token');
    process.exitCode = 2;
  `,
  );
  f.options.env.DOCTOR_ALIAS = 'nonstandard-sensitive-value';
  await writeFile(
    f.options.configPath,
    JSON.stringify({ api_key: '${DOCTOR_ALIAS}' }),
  );
  await assert.rejects(sdkDoctor(f.options), (error) => {
    assert.match(String(error), /SDK doctor could not complete \(exit 2\)/);
    assert.match(
      String(error),
      /services.default.model: missing variable MODEL_NAME/,
    );
    assert.doesNotMatch(
      String(error),
      /fixture-secret|stdout|nonstandard-sensitive-value|secret-password|url-token/,
    );
    return true;
  });
});

test('SDK malformed output is rejected without echoing its content', async (t) => {
  const f = await fixture(
    t,
    'process.stdout.write(process.env.DOCTOR_FIXTURE_KEY);',
  );
  await assert.rejects(sdkDoctor(f.options), (error) => {
    assert.match(String(error), /invalid JSON report/);
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
});

test('SDK cancellation reaches native SIGINT cleanup before the runner settles', async (t) => {
  const f = await fixture(
    t,
    `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.on('SIGINT', () => { writeFileSync(join(process.cwd(), 'cleaned'), 'yes'); process.exit(130); });
    process.send?.('ready');
    setInterval(() => {}, 1000);
  `,
  );
  const controller = new AbortController();
  const outcome = sdkDoctor({ ...f.options, signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  const child = await f.ready;
  controller.abort(new Error('SDK doctor test interrupted'));
  assert.match(String(await outcome), /test interrupted/);
  assert.equal(await readFile(join(f.root, 'cleaned'), 'utf8'), 'yes');
  assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
});

test('SDK cancellation falls back to terminating an uncooperative process tree', async (t) => {
  const f = await fixture(
    t,
    `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(join(process.cwd(), 'descendant'), String(child.pid));
    process.on('SIGINT', () => {});
    process.send?.('ready');
    setInterval(() => {}, 1000);
  `,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const outcome = sdkDoctor({ ...f.options, signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  const child = await f.ready;
  const descendant = Number(await readFile(join(f.root, 'descendant'), 'utf8'));
  controller.abort(new Error('SDK doctor forced interruption'));
  t.mock.timers.tick(60000);
  assert.match(String(await outcome), /forced interruption/);
  assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
});

test('SDK cancellation waits until the native signal listener is installed', async (t) => {
  const f = await fixture(
    t,
    `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.on('message', () => {
      process.on('SIGINT', () => { writeFileSync(join(process.cwd(), 'cleaned'), 'yes'); process.exit(130); });
    });
    process.send?.('ready');
    setInterval(() => {}, 1000);
  `,
  );
  const controller = new AbortController();
  const outcome = sdkDoctor({ ...f.options, signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  await f.ready;
  controller.abort(new Error('Cancelled during SDK initialization'));
  assert.match(String(await outcome), /Cancelled during SDK initialization/);
  assert.equal(await readFile(join(f.root, 'cleaned'), 'utf8'), 'yes');
});

test(
  'forced POSIX cancellation also retires separately detached SDK descendants',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(
      t,
      `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    writeFileSync(join(process.cwd(), 'descendant'), String(child.pid));
    process.on('SIGINT', () => {});
    process.send?.('ready');
    setInterval(() => {}, 1000);
  `,
    );
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const outcome = sdkDoctor({
      ...f.options,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await f.ready;
    const descendant = Number(
      await readFile(join(f.root, 'descendant'), 'utf8'),
    );
    controller.abort(new Error('Detached SDK interruption'));
    t.mock.timers.tick(60000);
    assert.match(String(await outcome), /Detached SDK interruption/);
    const state = await new Promise<string>((resolve) => {
      childProcess.execFile(
        'ps',
        ['-p', String(descendant), '-o', 'stat='],
        (error, stdout) => resolve(error ? '' : stdout.trim()),
      );
    });
    assert.ok(
      !state || state.startsWith('Z'),
      `SDK descendant must not still run: ${state}`,
    );
  },
);

test('SDK report output is bounded and native cleanup still runs on overflow', async (t) => {
  const f = await fixture(
    t,
    `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.on('SIGINT', () => { writeFileSync(join(process.cwd(), 'cleaned'), 'yes'); process.exit(130); });
    process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1024));
    setInterval(() => {}, 1000);
  `,
  );
  await assert.rejects(sdkDoctor(f.options), /report exceeded 8 MiB/);
  assert.equal(await readFile(join(f.root, 'cleaned'), 'utf8'), 'yes');
});

test('an already cancelled SDK diagnostic never starts a process', async (t) => {
  const f = await fixture(t, 'throw new Error("must not launch");');
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  await assert.rejects(
    sdkDoctor({ ...f.options, signal: controller.signal }),
    /Already cancelled/,
  );
  assert.equal(f.calls.length, 0);
});
