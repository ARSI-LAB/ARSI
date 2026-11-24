import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClaudeSandbox } from '../../src/plugins/agent-claudecode/sandbox.js';

const sandboxTest = process.platform === 'linux' ? test : test.skip;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'claude-sandbox-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'claude.cjs');
  await writeFile(
    executable,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
 const replies = {
  initialize: {sandbox_enabled:true, claude_code_version:'2.1.331'},
  get_settings: {effective:settings, sources:[{source:'flagSettings', settings}]},
  get_hooks_listing: {hooks:[]},
  mcp_status: {mcpServers:[]},
 };
 for (const line of input.trim().split('\\n')) {
  const message=JSON.parse(line);
  console.log(JSON.stringify({type:'control_response', response:{subtype:'success',request_id:message.request_id,response:replies[message.request.subtype]}}));
 }
});`,
  );
  return { root, executable };
}

for (const sandbox of ['read-only', 'workspace-write'] as const) {
  sandboxTest(
    `Claude ${sandbox} prepares a private native configuration`,
    async (t) => {
      const f = await fixture(t);
      const prepared = await prepareClaudeSandbox(
        { executable: f.executable, sandbox },
        f.root,
        new AbortController().signal,
      );
      t.after(() => prepared.dispose());
      const tools = prepared.args[prepared.args.indexOf('--tools') + 1];
      assert.equal(
        tools,
        sandbox === 'read-only' ? 'Glob,Grep' : 'Read,Glob,Grep,Bash',
      );
      assert.ok(prepared.args.includes('--strict-mcp-config'));
      assert.ok(prepared.args.includes('--restricted'));
      assert.ok(prepared.args.includes('--safe-mode'));
      assert.notEqual(
        prepared.env?.CLAUDE_CONFIG_DIR,
        process.env.CLAUDE_CONFIG_DIR,
      );
      const state = prepared.env?.CLAUDE_CONFIG_DIR;
      assert.equal(typeof state, 'string');
      await prepared.dispose();
      await assert.rejects(readFile(String(state)), { code: 'ENOENT' });
    },
  );
}

test('Claude inherit keeps native launch configuration', async () => {
  const prepared = await prepareClaudeSandbox(
    { executable: 'missing-claude' },
    '.',
    new AbortController().signal,
  );
  assert.deepEqual(prepared.args, []);
  assert.equal(prepared.env, undefined);
  await prepared.dispose();
});

sandboxTest(
  'Claude rejects a sandbox that failed before model submission',
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.executable,
      'console.log(JSON.stringify({type:"result", is_error:true, startup_failure_reason:"sandbox_required_unavailable"}));',
    );
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: f.executable, sandbox: 'workspace-write' },
        f.root,
        new AbortController().signal,
      ),
      /sandbox.*unavailable/i,
    );
  },
);

sandboxTest(
  'Claude sandbox retains provider settings without inheriting executable hooks',
  async (t) => {
    const f = await fixture(t);
    const original = process.env.CLAUDE_CONFIG_DIR;
    const { mkdir } = await import('node:fs/promises');
    const nativeConfig = join(f.root, 'native-config');
    await mkdir(nativeConfig);
    await writeFile(
      join(nativeConfig, 'settings.json'),
      JSON.stringify({
        model: 'native-model',
        effortLevel: 'high',
        env: {
          ANTHROPIC_BASE_URL: 'http://localhost:1234',
          ANTHROPIC_AUTH_TOKEN: 'fixture-private-token',
          NODE_OPTIONS: '--import=untrusted.js',
          CLAUDE_CONFIG_DIR: '/host/config',
        },
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'untrusted' }] },
          ],
        },
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = nativeConfig;
    t.after(() => {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    });
    const prepared = await prepareClaudeSandbox(
      { executable: f.executable, sandbox: 'read-only' },
      f.root,
      new AbortController().signal,
    );
    t.after(() => prepared.dispose());
    const settings = JSON.parse(
      prepared.args[prepared.args.indexOf('--settings') + 1]!,
    );
    assert.equal(settings.model, 'native-model');
    assert.equal(settings.effortLevel, 'high');
    assert.equal(settings.env, undefined);
    assert.equal(
      prepared.args.join(' ').includes('fixture-private-token'),
      false,
    );
    assert.equal(
      prepared.env?.ANTHROPIC_BASE_URL,
      process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:1234',
    );
    assert.equal(
      prepared.env?.ANTHROPIC_AUTH_TOKEN,
      process.env.ANTHROPIC_AUTH_TOKEN ?? 'fixture-private-token',
    );
    assert.notEqual(prepared.env?.NODE_OPTIONS, '--import=untrusted.js');
    assert.notEqual(prepared.env?.CLAUDE_CONFIG_DIR, '/host/config');
    assert.equal(settings.hooks, undefined);
  },
);

sandboxTest(
  'Claude failed native sandbox preflight redacts provider output',
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.executable,
      'console.log("fixture-provider-secret"); process.exit(1);',
    );
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: f.executable, sandbox: 'read-only' },
        f.root,
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /sandbox.*preflight/i);
        assert.equal(error.message.includes('fixture-provider-secret'), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  },
);

sandboxTest(
  'Claude refuses a task before launch when sandbox initialization fails',
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.executable,
      'console.log(JSON.stringify({type:"result",is_error:true}));',
    );
    const { runSession } = await import(
      '../../src/plugins/agent-claudecode/session.js'
    );
    let launched = false;
    await assert.rejects(
      runSession({
        config: { executable: f.executable, sandbox: 'read-only' },
        directory: f.root,
        request: {
          cwd: f.root,
          goal: 'Return JSON',
          outputSchema: { type: 'object' },
        },
        signal: new AbortController().signal,
        record() {},
        async launch() {
          launched = true;
        },
      }),
      /sandbox.*unavailable/i,
    );
    assert.equal(launched, false);
  },
);

sandboxTest(
  'Claude concurrent sandbox preparations have independent state and restrictions',
  async (t) => {
    const f = await fixture(t);
    const launches = await Promise.all(
      (['read-only', 'workspace-write'] as const).map((sandbox) =>
        prepareClaudeSandbox(
          { executable: f.executable, sandbox },
          f.root,
          new AbortController().signal,
        ),
      ),
    );
    t.after(() =>
      Promise.all(launches.map((launch) => launch.dispose())).then(() => {}),
    );
    assert.notEqual(
      launches[0]!.env?.CLAUDE_CONFIG_DIR,
      launches[1]!.env?.CLAUDE_CONFIG_DIR,
    );
    assert.equal(launches[0]!.args.includes('Read,Glob,Grep,Bash'), false);
    assert.equal(launches[1]!.args.includes('Read,Glob,Grep,Bash'), true);
  },
);

sandboxTest(
  'Claude rechecks the actual process before sending a sandboxed task',
  async (t) => {
    const f = await fixture(t);
    const { runSession } = await import(
      '../../src/plugins/agent-claudecode/session.js'
    );
    let sentTask = false;
    await assert.rejects(
      runSession({
        config: { executable: f.executable, sandbox: 'read-only' },
        directory: f.root,
        request: {
          cwd: f.root,
          goal: 'Private task',
          outputSchema: { type: 'object' },
        },
        signal: new AbortController().signal,
        record() {},
        async launch(spec, onLine) {
          sentTask = spec.input.includes('Private task');
          await onLine(
            JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: 'initialize',
                response: { sandbox_enabled: false },
              },
            }),
            (message) => {
              if (JSON.stringify(message).includes('Private task'))
                sentTask = true;
            },
          );
        },
      }),
      /sandbox.*unavailable|sandbox.*verify/i,
    );
    assert.equal(sentTask, false);
  },
);

sandboxTest(
  'Claude rejects effective settings that allow escaping the native sandbox',
  async (t) => {
    const f = await fixture(t);
    const script = await readFile(f.executable, 'utf8');
    await writeFile(
      f.executable,
      script.replace(
        'const replies = {',
        'settings.sandbox.allowNestedUserNamespaces = true; const replies = {',
      ),
    );
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: f.executable, sandbox: 'workspace-write' },
        f.root,
        new AbortController().signal,
      ),
      /settings conflict/,
    );
  },
);

sandboxTest(
  'Claude cancelled preflight removes its temporary authentication state',
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.executable,
      `
const fs = require('node:fs');
fs.writeFileSync(__dirname + '/state-path', process.env.CLAUDE_CONFIG_DIR);
setInterval(() => {}, 1000);
`,
    );
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: f.executable, sandbox: 'read-only' },
        f.root,
        AbortSignal.timeout(300),
      ),
      /abort|timeout/i,
    );
    const state = await readFile(join(f.root, 'state-path'), 'utf8');
    await assert.rejects(readFile(join(state, '.credentials.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(state), { code: 'ENOENT' });
  },
);

sandboxTest(
  'Claude rejects MCP servers enforced outside explicit launch flags',
  async (t) => {
    const f = await fixture(t);
    const script = await readFile(f.executable, 'utf8');
    await writeFile(
      f.executable,
      script.replace(
        'mcp_status: {mcpServers:[]}',
        'mcp_status: {mcpServers:[{name:"managed-unconfined"}]}',
      ),
    );
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: f.executable, sandbox: 'read-only' },
        f.root,
        new AbortController().signal,
      ),
      /settings conflict/,
    );
  },
);

test(
  'Claude explicit sandbox rejects unsupported platforms',
  { skip: process.platform === 'linux' },
  async () => {
    await assert.rejects(
      prepareClaudeSandbox(
        { executable: 'unused', sandbox: 'read-only' },
        '.',
        new AbortController().signal,
      ),
      /require Linux/,
    );
  },
);
