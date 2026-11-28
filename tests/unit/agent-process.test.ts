import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProcessLauncher } from '../../src/runtime/services/agent-execution/process.js';

test(
  'Agent processes receive input in the project cwd and preserve task input and the final Unicode line',
  { timeout: 30000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'rsi-process-protocol-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const launch = agentProcessLauncher({
      project: directory,
      signal: AbortSignal.timeout(20000),
    });
    const lines: string[] = [];
    await launch(
      {
        executable: process.execPath,
        args: [
          '-e',
          'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text:"完整消息",cwd:process.cwd(),input})))',
        ],
        input: '  任务\r\nfinish  ',
      },
      (line) => {
        lines.push(line);
      },
    );
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [{ text: '完整消息', cwd: directory, input: '  任务\r\nfinish  ' }],
    );
  },
);

test(
  'Windows accepts cancellation immediately after spawning the CLI',
  {
    skip: process.platform !== 'win32',
    timeout: 10000,
  },
  async () => {
    const controller = new AbortController();
    const launch = agentProcessLauncher({
      project: tmpdir(),
      signal: controller.signal,
    });
    const running = launch(
      {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        input: '',
      },
      () => {},
    );
    controller.abort(new Error('cancel during startup'));
    await assert.rejects(running, /cancel during startup/);
  },
);

test(
  'cancelling an Agent stops both its process and its active descendants',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'rsi-process-cancellation-'),
    );
    const controller = new AbortController();
    const launch = agentProcessLauncher({
      project: directory,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    const ticks = join(directory, 'ticks');
    // Keep the descendant alive through SIGTERM to exercise forced group cleanup.
    const descendant = `process.on('SIGTERM',()=>{});const fs=require('node:fs');const tick=()=>fs.appendFileSync(${JSON.stringify(ticks)},'x');tick();console.log('ready');setInterval(tick,20);`;
    const running = launch(
      {
        executable: process.execPath,
        args: [
          '-e',
          `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000);`,
        ],
        input: '',
      },
      (line) => {
        if (line === 'ready') controller.abort(new Error('probe cancelled'));
      },
    );
    t.after(async () => {
      controller.abort();
      await running.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    await assert.rejects(running, /probe cancelled/);
    const before = await readFile(ticks, 'utf8');
    assert(before.length > 0, 'The descendant must run before cancellation');
    await delay(120);
    assert.equal(await readFile(ticks, 'utf8'), before);
  },
);

test(
  'cleanup uncertainty takes precedence over a preceding protocol failure',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'rsi-process-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = process.kill;
    const cleanupError = Object.assign(
      new Error('Synthetic permission failure'),
      { code: 'EPERM' },
    );
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal === 'SIGTERM') throw cleanupError;
      return original(pid, signal);
    }) as typeof process.kill;
    t.after(() => {
      process.kill = original;
    });
    const launch = agentProcessLauncher({
      project: directory,
      signal: new AbortController().signal,
    });
    await assert.rejects(
      launch(
        {
          executable: process.execPath,
          args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
          input: '',
        },
        () => {
          throw new Error('Invalid protocol');
        },
      ),
      (error: Error) => {
        assert.ok(
          error instanceof Error &&
            'status' in error &&
            error.status === 'unknown',
        );
        return true;
      },
    );
  },
);

test(
  'Darwin accepts a cleanup permission error after the group has disappeared',
  { skip: process.platform !== 'darwin', timeout: 10000 },
  async (t) => {
    const original = process.kill;
    t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals) => {
      if (pid < 0 && signal === 'SIGKILL') {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return original(pid, signal);
    });
    const lines: string[] = [];
    await agentProcessLauncher({
      project: tmpdir(),
      signal: AbortSignal.timeout(5000),
    })(
      {
        executable: process.execPath,
        args: ['-e', 'console.log("done")'],
        input: '',
      },
      (line) => {
        lines.push(line);
      },
    );
    assert.deepEqual(lines, ['done']);
  },
);
