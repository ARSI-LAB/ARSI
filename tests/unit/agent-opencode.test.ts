import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeContext } from '../../src/contracts/index.js';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { configSchema } from '../../src/plugins/agent-opencode/schema.js';
import { parseConfig } from '../../src/shared/schema.js';
import { launchEnvironment } from '../../src/plugins/agent-opencode/session.js';
const outputSchema = {
  type: 'object',
  properties: { ok: { const: true } },
  required: ['ok'],
  additionalProperties: false,
};
async function fixture(timeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-opencode-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const controller = new AbortController();
  const context = new RuntimeContext().extend({
    directory: join(root, 'call'),
    signal: controller.signal,
  });
  const agent = await createAgentOpenCode(
    {
      executable: resolve('tests/fixtures/opencode-cli.cjs'),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    context,
  );
  return {
    root,
    cwd,
    controller,
    agent,
    run: (goal: string) => agent.execute({ cwd, goal, outputSchema }, context),
    close: async () => {
      await agent.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('OpenCode defaults to the native executable and rejects invalid configuration', () => {
  assert.deepEqual(parseConfig(configSchema, {}, 'config'), {
    executable: 'opencode',
  });
  for (const value of [{ model: ' ' }, { timeoutMs: 0 }, { api_key: 'secret' }])
    assert.throws(() => parseConfig(configSchema, value, 'config'));
});
test('OpenCode preserves inline model/auth configuration and independently restricts the task agent', (t) => {
  const before = process.env.OPENCODE_CONFIG_CONTENT;
  t.after(() => {
    if (before === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = before;
  });
  const config = {
    model: 'provider/model',
    providers: { provider: { settings: { apiKey: 'fixture-key' } } },
    agents: { other: { model: 'provider/other' } },
  };
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  const env = launchEnvironment('rsi-test', '/task');
  assert.equal(env.PWD, '/task');
  const actual = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  assert.equal(actual.model, config.model);
  assert.deepEqual(actual.providers, config.providers);
  assert.deepEqual(actual.agents.other, config.agents.other);
  assert.deepEqual(actual.agents['rsi-test'].permissions, [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', 'skill'].map((action) => ({
      action,
      resource: '*',
      effect: 'allow',
    })),
  ]);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, JSON.stringify(config));
  process.env.OPENCODE_CONFIG_CONTENT = 'invalid-secret-config';
  assert.throws(
    () => launchEnvironment('rsi-test', '/task'),
    /^Error: OPENCODE_CONFIG_CONTENT must be a JSON object\.$/,
  );
});
test('OpenCode collects final text chunks, validates output and starts private independent calls', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.deepEqual(await f.run('success'), { ok: true });
  const first = JSON.parse(await readFile(join(f.cwd, 'audit.json'), 'utf8'));
  assert.equal(first.pwd, first.cwd);
  assert.equal(first.cwd, f.cwd);
  assert(first.args.includes('--standalone'));
  assert(first.args.includes('--archived'));
  assert(!first.args.includes('--auto'));
  assert(!first.args.includes('--model'));
  assert.deepEqual(await f.run('success'), { ok: true });
  const second = JSON.parse(await readFile(join(f.cwd, 'audit.json'), 'utf8'));
  assert.notEqual(first.agent, second.agent);
  const diagnostics = await readFile(
    join(f.root, 'call', 'diagnostics.jsonl'),
    'utf8',
  );
  assert(diagnostics.includes('validation_succeeded'));
});
for (const goal of [
  'error',
  'malformed',
  'invalid',
  'missing',
  'wrong-session',
  'truncated',
  'exit',
])
  test(`OpenCode rejects ${goal} without exposing native error content`, async (t) => {
    const f = await fixture();
    t.after(f.close);
    await assert.rejects(
      f.run(goal),
      (error) =>
        error instanceof Error && !error.message.includes('secret-native-key'),
    );
  });
for (const kind of ['timeout', 'abort', 'dispose'])
  test(`OpenCode ${kind} stops the CLI and descendants`, async (t) => {
    const f = await fixture(kind === 'timeout' ? 1500 : undefined);
    t.after(f.close);
    const running = f.run('wait');
    const rejection = assert.rejects(running);
    let pid: number | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        pid = Number(await readFile(join(f.cwd, 'child.pid'), 'utf8'));
        break;
      } catch {
        await delay(20);
      }
    }
    assert(pid);
    if (kind === 'abort') f.controller.abort(new Error('cancelled'));
    if (kind === 'dispose') await f.agent.dispose();
    await rejection;
    assert.throws(() => process.kill(pid, 0));
  });
