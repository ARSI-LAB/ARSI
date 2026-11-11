import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { RuntimeContext } from '../../src/contracts/index.js';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';

const outputSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
async function fixture(timeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dsh-test-'));
  const cwd = join(root, 'project');
  const directory = join(root, 'call');
  await mkdir(cwd);
  const controller = new AbortController();
  const context = new RuntimeContext().extend({
    directory,
    signal: controller.signal,
    async charge() {
      throw new Error('No invented usage');
    },
  });
  const operation = await createAgentDsh(
    {
      executable: resolve('tests/fixtures/dsh-cli.cjs'),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    context,
  );
  return {
    root,
    cwd,
    directory,
    controller,
    dispose: () => operation.dispose(),
    run: (goal: string) =>
      operation.execute({ goal, cwd, outputSchema }, context),
    async close() {
      controller.abort();
      await operation.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('DSH runs read-only without approvals, validates JSON, cleans overlays, and starts fresh', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.run('success'), { ok: true });
    assert.deepEqual(await f.run('success'), { ok: true });
    assert.deepEqual(await readdir(f.directory), ['diagnostics.jsonl']);
  } finally {
    await f.close();
  }
});
for (const goal of [
  'missing',
  'malformed',
  'invalid',
  'aborted',
  'exit-failure',
  'error',
]) {
  test(`DSH rejects ${goal} without retry`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        f.run(goal),
        (error) =>
          error instanceof Error &&
          !error.message.includes('secret-do-not-log'),
      );
      const diagnostics = await readFile(
        join(f.directory, 'diagnostics.jsonl'),
        'utf8',
      );
      assert.equal(diagnostics.includes('validation_succeeded'), false);
      assert.equal(diagnostics.includes('secret-do-not-log'), false);
      assert.deepEqual(await readdir(f.directory), ['diagnostics.jsonl']);
    } finally {
      await f.close();
    }
  });
}
test(
  'DSH timeout stops its process group and cleans the launch overlay',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture(1000);
    try {
      await assert.rejects(f.run('wait'), /timed out/);
      const pid = Number(await readFile(join(f.cwd, 'child.pid'), 'utf8'));
      assert.throws(() => process.kill(pid, 0));
      assert.deepEqual(await readdir(f.directory), ['diagnostics.jsonl']);
    } finally {
      await f.close();
    }
  },
);
test('DSH respects cancellation before launch', async () => {
  const f = await fixture();
  try {
    f.controller.abort(new Error('cancelled'));
    await assert.rejects(f.run('success'), /cancelled/);
  } finally {
    await f.close();
  }
});

test('DSH active cancellation stops execution and permits a subsequent independent call', async () => {
  const f = await fixture();
  try {
    const running = f.run('wait');
    const rejection = assert.rejects(running, /cancelled/);
    await new Promise<void>((done) => setTimeout(done, 150));
    f.controller.abort(new Error('cancelled'));
    await rejection;
    assert.deepEqual(await readdir(f.directory), ['diagnostics.jsonl']);
  } finally {
    await f.close();
  }
  const next = await fixture();
  try {
    assert.deepEqual(await next.run('success'), { ok: true });
  } finally {
    await next.close();
  }
});
test(
  'DSH cleans background descendants even after successful exit and records native usage',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      assert.deepEqual(await f.run('background'), { ok: true });
      const pid = Number(await readFile(join(f.cwd, 'child.pid'), 'utf8'));
      await new Promise<void>((done) => setTimeout(done, 50));
      assert.throws(() => process.kill(pid, 0));
      const diagnostics = await readFile(
        join(f.directory, 'diagnostics.jsonl'),
        'utf8',
      );
      assert.match(diagnostics, /"inputTokens":12/);
    } finally {
      await f.close();
    }
  },
);
test('DSH rejects invalid configuration and native role dispatch before launch', async () => {
  const context = new RuntimeContext().extend({
    signal: new AbortController().signal,
  });
  await assert.rejects(createAgentDsh({ timeoutMs: 0 }, context), /config/);
  const operation = await createAgentDsh({}, context);
  await assert.rejects(
    operation.execute(
      { goal: '', cwd: '.', role: 'reviewer', outputSchema },
      context,
    ),
    /native subagents/,
  );
});

test('DSH disposal waits for active execution cleanup, including startup', async () => {
  for (const delay of [0, 150]) {
    const f = await fixture();
    try {
      const running = f.run('wait');
      const rejected = assert.rejects(running, /disposed/);
      if (delay) await new Promise<void>((done) => setTimeout(done, delay));
      await f.dispose();
      await rejected;
      assert.equal(
        (await readdir(f.directory)).some((name) =>
          name.startsWith('dsh-launch-'),
        ),
        false,
      );
    } finally {
      await f.close();
    }
  }
});
