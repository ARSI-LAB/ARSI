import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentObservation,
  JsonObject,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { dshSandboxPatches } from '../../src/plugins/agent-dsh/sandbox.js';
import { runDshProcess } from '../../src/plugins/agent-dsh/process.js';

const rows = [
  { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
  { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' },
  { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox' },
  { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
  { id: 'approval', name: '@deepseek-ai/dsh-user-approval' },
  { id: 'headless-runner', name: '@deepseek-ai/dsh-headless' },
  { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' },
  { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' },
  { id: 'authorization', name: '@deepseek-ai/dsh-authorization' },
  {
    id: 'deepseek-account',
    name: '@deepseek-ai/dsh-deepseek-account-platform',
  },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
];

test('DSH sandbox confines file and shell capabilities and disables unknown profile plugins', () => {
  const patches = dshSandboxPatches(
    'read-only',
    '/work',
    rows,
    [...rows, { id: 'host-mcp', name: 'host-mcp' }],
    '/guard.mjs',
  );
  assert.deepEqual(
    [...patches].reverse().find((p) => p.id === 'sandbox-policy')?.config,
    {
      mode: 'read-only',
      workspaceRoot: '/work',
    },
  );
  assert.equal(
    [...patches].reverse().find((p) => p.id === 'host-mcp')?.disabled,
    true,
  );
  assert.equal(
    object([...patches].reverse().find((p) => p.id === 'approval')?.config)
      .policy,
    'never',
  );
  assert.deepEqual(
    [...patches].reverse().find((p) => p.id === 'headless-runner')?.inject,
    ['headlessStartup', 'rsiSandboxReady'],
  );
});

test('DSH sandbox rejects a native composition with a missing enforcing capability', () => {
  assert.throws(
    () =>
      dshSandboxPatches(
        'workspace-write',
        '/work',
        rows.filter((r) => r.id !== 'fs-sandbox'),
        rows,
        '/guard.mjs',
      ),
    /fs-sandbox/,
  );
});

test('DSH sandbox rejects replaced native authentication and duplicate entries before startup', () => {
  assert.throws(
    () =>
      dshSandboxPatches(
        'read-only',
        '/work',
        rows,
        rows.map((row) =>
          row.id === 'credentials' ? { ...row, name: 'host-code' } : row,
        ),
        '/guard.mjs',
      ),
    /credentials/,
  );
  assert.throws(
    () =>
      dshSandboxPatches(
        'read-only',
        '/work',
        rows,
        [...rows, rows[0]!],
        '/guard.mjs',
      ),
    /unique/,
  );
});

test('DSH sandbox resets native execution configuration and keeps literal model selection', () => {
  const defaults: JsonObject[] = [
    ...rows,
    { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env', config: {} },
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: 'deepseek-official', model: 'default' },
    },
  ];
  const effective = defaults.map(
    (row): JsonObject =>
      row.id === 'shell-env'
        ? { ...row, config: { command: 'host-command' } }
        : row.id === 'agent-default-model'
          ? {
              ...row,
              config: { provider: 'deepseek-official', model: 'selected' },
            }
          : row,
  );
  const patches = dshSandboxPatches(
    'workspace-write',
    '/work',
    defaults,
    effective,
    '/guard.mjs',
  );
  assert.deepEqual(patches.find((p) => p.id === 'shell-env')?.config, {});
  assert.deepEqual(
    patches.find((p) => p.id === 'agent-default-model')?.config,
    {
      provider: 'deepseek-official',
      model: 'selected',
    },
  );
  assert.throws(
    () =>
      dshSandboxPatches(
        'read-only',
        '/work',
        defaults,
        effective.map((row) =>
          row.id === 'agent-default-model'
            ? { ...row, config: { model: { __jsExpr: 'hostCommand()' } } }
            : row,
        ),
        '/guard.mjs',
      ),
    /literal/,
  );
});

test('DSH sandbox rejects inherited structural entry fields before mounting', () => {
  const extras: JsonObject[] = [
    { group: true },
    { children: [] },
    { arbitrary: true },
  ];
  for (const extra of extras)
    assert.throws(
      () =>
        dshSandboxPatches(
          'read-only',
          '/work',
          rows,
          rows.map((row) => (row.id === 'tools' ? { ...row, ...extra } : row)),
          '/guard.mjs',
        ),
      /entry fields/,
    );
});

test('DSH rejects an unsupported explicit sandbox before submitting a task', async (t) => {
  const { createAgentDsh } = await import(
    '../../src/plugins/agent-dsh/service.js'
  );
  const { agentFixture } = await import('../fixtures/agent-execution.js');
  let submitted = false;
  const fixture = await agentFixture(async () => {
    submitted = true;
  });
  t.after(() => fixture.close());
  const agent = await createAgentDsh(
    { executable: process.execPath, sandbox: 'read-only' },
    fixture.context,
  );
  await assert.rejects(
    fixture.execute(agent),
    /DSH sandbox preparation failed|require Linux/,
  );
  assert.equal(submitted, false);
});

test('DSH forwards private environment and records the actual submitted prompt', async () => {
  const records: AgentObservation[] = [];
  const env = { DSH_HOME: '/private-call-home' };
  const outputSchema = { type: 'object' };
  let launched = false;
  await runDshProcess(
    process.execPath,
    '/call/launch.json',
    'actual native prompt',
    () => {},
    async (spec) => {
      launched = true;
      assert.equal(spec.env, env);
      assert.equal(spec.input, 'actual native prompt');
      assert.deepEqual(spec.args, [
        '--profile',
        'headless',
        '--patch',
        '/call/launch.json',
        '--json',
        '-',
      ]);
      assert.deepEqual(
        records.map((record) => record.event),
        [{ type: 'task.submitted', text: spec.input, outputSchema }],
      );
    },
    { record: (record) => records.push(record), outputSchema, env },
  );
  assert.equal(launched, true);
});

test('DSH inherit mode rejects a metadata-free final from an unverified CLI', async (t) => {
  const { createAgentDsh } = await import(
    '../../src/plugins/agent-dsh/service.js'
  );
  const { agentFixture } = await import('../fixtures/agent-execution.js');
  const fixture = await agentFixture(async (_spec, consume) => {
    await consume(
      JSON.stringify({ type: 'session', sessionId: 'session' }),
      () => {},
    );
    await consume(
      JSON.stringify({ type: 'final', text: '{"answer":"ok"}' }),
      () => {},
    );
  });
  t.after(() => fixture.close());
  const agent = await createAgentDsh(
    { executable: process.execPath },
    fixture.context,
  );
  await assert.rejects(fixture.execute(agent), /Invalid DSH final session/);
});
