import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { configSchema } from '../../src/plugins/agent-claudecode/schema.js';
import { parseConfig } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output: { answer: 'ok' },
  usage: { input_tokens: 5, output_tokens: 2 },
  permission_denials: [],
};
async function fixture(spec: JsonObject, timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-claudecode-'));
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(spec));
  const controller = new AbortController();
  const context = new RuntimeContext().extend({
    directory,
    signal: controller.signal,
    charge: async () => {
      throw new Error('Invented usage');
    },
  });
  const agent = await createAgentClaudeCode(
    {
      executable: resolve('tests/fixtures/claudecode-cli.cjs'),
      model: 'test-model',
      effort: 'low',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    context,
  );
  return {
    directory,
    controller,
    agent,
    run: () =>
      agent.execute(
        { goal: 'Inspect', cwd: directory, outputSchema: schema },
        context,
      ),
    close: async () => {
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Claude Code config rejects invalid fields and defaults the native executable', () => {
  assert.deepEqual(parseConfig(configSchema, {}, 'config'), {
    executable: 'claude',
  });
  for (const config of [
    { model: ' ' },
    { effort: 'invalid' },
    { timeoutMs: 0 },
    { extra: true },
  ])
    assert.throws(() => parseConfig(configSchema, config, 'config'));
});

test('Claude Code returns validated native output and records only supplied usage', async (t) => {
  const f = await fixture({ events: [success] });
  t.after(f.close);
  assert.deepEqual(await f.run(), { answer: 'ok' });
  assert.deepEqual(await f.run(), { answer: 'ok' });
  const audit = object(
    JSON.parse(await readFile(join(f.directory, 'audit.json'), 'utf8')),
  );
  const args = audit.args;
  assert(Array.isArray(args));
  for (const flag of ['--no-session-persistence', '--strict-mcp-config'])
    assert(args.includes(flag));
  assert(!args.includes('--restricted'));
  assert(!args.includes('--setting-sources'));
  assert.equal(
    args[args.indexOf('--disallowedTools') + 1],
    'Write,Edit,NotebookEdit,Bash,PowerShell,mcp__*',
  );
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill,Agent');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  const records = (
    await readFile(join(f.directory, 'diagnostics.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => object(JSON.parse(line)));
  assert.equal(records.filter((r) => r.type === 'token_usage').length, 2);
  assert.equal(
    records.filter((r) => r.type === 'validation_succeeded').length,
    2,
  );
});

for (const [name, spec, error] of [
  [
    'missing structured result',
    {
      events: [
        { ...success, structured_output: undefined, result: '{"answer":"ok"}' },
      ],
    },
    /no structured output/,
  ],
  [
    'invalid schema',
    { events: [{ ...success, structured_output: { answer: 2 } }] },
    /agent output/,
  ],
  [
    'native failure',
    {
      events: [
        { ...success, subtype: 'error_during_execution', is_error: true },
      ],
    },
    /task failed/,
  ],
  [
    'permission denied',
    { events: [{ ...success, permission_denials: [{ tool_name: 'Write' }] }] },
    /requires permission/,
  ],
  [
    'duplicate terminal result',
    { events: [success, success] },
    /multiple terminal/,
  ],
  ['missing terminal result', { events: [] }, /no validated output/],
  ['malformed stream', { invalid: true }, /JSON/],
  [
    'nonzero exit after result',
    { events: [success], exitCode: 1 },
    /exited with 1/,
  ],
] as const) {
  test(`Claude Code rejects ${name}`, async (t) => {
    const f = await fixture(JSON.parse(JSON.stringify(spec)));
    t.after(f.close);
    await assert.rejects(f.run(), error);
  });
}

for (const kind of ['timeout', 'abort', 'dispose'] as const) {
  test(`Claude Code ${kind} stops the CLI and descendants`, async (t) => {
    const f = await fixture(
      { hang: true },
      kind === 'timeout' ? 1000 : undefined,
    );
    t.after(f.close);
    const pending = f.run();
    const rejected = assert.rejects(pending, /timed out|cancelled|disposed/);
    let audit: JsonObject | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        audit = object(
          JSON.parse(await readFile(join(f.directory, 'audit.json'), 'utf8')),
        );
        break;
      } catch {
        await delay(10);
      }
    }
    assert(audit);
    if (kind === 'abort') f.controller.abort(new Error('cancelled'));
    if (kind === 'dispose') await f.agent.dispose();
    await rejected;
    for (const id of [audit.pid, audit.child]) {
      assert.equal(typeof id, 'number');
      // Reaping an orphan may lag behind the process group's closed pipes.
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(Number(id), 0);
          await delay(10);
        } catch {
          break;
        }
      }
      assert.throws(() => process.kill(Number(id), 0), /ESRCH/);
    }
    const records = await readFile(
      join(f.directory, 'diagnostics.jsonl'),
      'utf8',
    );
    assert.doesNotMatch(records, /"type":"token_usage"/);
  });
}

test('Claude Code reports executable launch failures', async (t) => {
  const f = await fixture({});
  t.after(f.close);
  const context = new RuntimeContext().extend({
    directory: f.directory,
    signal: f.controller.signal,
  });
  const agent = await createAgentClaudeCode(
    { executable: join(f.directory, 'absent') },
    context,
  );
  await assert.rejects(
    agent.execute(
      { goal: '', cwd: f.directory, outputSchema: schema },
      context,
    ),
    /ENOENT/,
  );
  await agent.dispose();
});
