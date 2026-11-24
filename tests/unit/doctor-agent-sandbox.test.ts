import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type DoctorContext,
  type JsonObject,
} from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/index.js';
import { checkClaudeCodeAgent } from '../../src/plugins/agent-claudecode/doctor.js';
import { checkCodexAgent } from '../../src/plugins/agent-codex/doctor.js';
import { checkDshAgent } from '../../src/plugins/agent-dsh/doctor.js';
import { runDoctorRules } from '../../src/runtime/doctor/rules.js';
import { object } from '../../src/shared/json.js';

async function fixture(t: TestContext, pluginId: string) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-doctor-agent-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'native.cjs');
  const calls = join(root, 'calls.jsonl');
  if (pluginId === 'agent.claudecode') {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'native-config');
    t.after(() => {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    });
  }
  const context = (config: JsonObject): DoctorContext => {
    const definition = {
      id: pluginId,
      description: 'Doctor fixture',
      contract: agentContract,
      configSchema: {},
      async create(): Promise<never> {
        throw new Error('Doctor must not execute a model task');
      },
    };
    const binding = {
      name: 'probe',
      pluginId,
      config: { executable, ...config },
      definition,
    };
    return {
      binding,
      recipe: {
        application: binding,
        bindings: { probe: binding },
        policyConfig: {},
      },
      registry: {
        get: () => definition,
        assertContract() {},
      },
      runtime: new RuntimeContext().extend({ rootDirectory: root }),
      directory: root,
      signal: new AbortController().signal,
    };
  };
  const invocations = async (): Promise<JsonObject[]> =>
    (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
  return { root, executable, calls, context, invocations };
}

const sandboxTest = process.platform === 'linux' ? test : test.skip;

for (const sandbox of ['read-only', 'workspace-write'] as const) {
  sandboxTest(
    `Codex Doctor applies ${sandbox} preparation to native network diagnostics`,
    async (t) => {
      const f = await fixture(t, 'agent.codex');
      await writeFile(
        f.executable,
        `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({args}) + '\\n');
if (args[0] === '--help') console.log('Commands:\\n  doctor  Check health');
else if (args[0] === 'doctor' && args[1] === '--help') console.log('--json --network-only');
else if (args.includes('app-server')) {
  const lines = require('node:readline').createInterface({input:process.stdin});
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({message}) + '\\n');
    if (!message.id) return;
    const features = Object.fromEntries(args.filter((arg) => arg.startsWith('features.')).map((arg) => [arg.slice(9, arg.indexOf('=')), false]));
    const result = message.method === 'config/read'
      ? {config:{features,mcp_servers:{},sandbox_workspace_write:{writable_roots:[]},notify:[]}}
      : message.method === 'command/exec' ? {exitCode:0} : {};
    console.log(JSON.stringify({id:message.id,result}));
  });
} else if (args.includes('doctor')) console.log(JSON.stringify({schemaVersion:1,overallStatus:'ok',checks:{'network.provider_reachability':{status:'ok'}}}));
else throw new Error('Unexpected model task');
`,
      );
      const context = f.context({ sandbox });
      const rules = checkCodexAgent(context);
      assert.deepEqual(await readdir(f.root), ['native.cjs']);
      const result = await runDoctorRules(rules, context.signal);
      assert.deepEqual(
        result.checks.map(({ id, status }) => [id, status]),
        [
          ['executable', 'passed'],
          ['sandbox', 'passed'],
          ['doctor', 'passed'],
          ['model-access', 'unchecked'],
        ],
      );
      const invocations = await f.invocations();
      const diagnostic = invocations.find(
        (call) => Array.isArray(call.args) && call.args.includes('--json'),
      );
      assert.ok(Array.isArray(diagnostic?.args));
      assert.ok(diagnostic.args.includes(`sandbox_mode="${sandbox}"`));
      assert.ok(diagnostic.args.includes('mcp_servers={}'));
      assert.ok(diagnostic.args.includes('--network-only'));
      assert.deepEqual(
        invocations
          .filter((call) => call.message)
          .map((call) => object(call.message).method),
        ['initialize', 'initialized', 'config/read', 'command/exec'],
      );
    },
  );
}

sandboxTest(
  'Codex sandbox failure blocks native diagnostics and retains later rules',
  async (t) => {
    const f = await fixture(t, 'agent.codex');
    await writeFile(
      f.executable,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({args}) + '\\n');
if (args[0] === '--help') console.log('Commands:\\n  doctor  Check health');
else if (args[0] === 'doctor') console.log('--json');
else if (args.includes('app-server')) console.log(JSON.stringify({id:1,error:{message:'fixture-secret'}}));
else throw new Error('Unexpected model task');
`,
    );
    const context = f.context({ sandbox: 'read-only' });
    const result = await runDoctorRules(
      checkCodexAgent(context),
      context.signal,
    );
    assert.deepEqual(
      result.checks.map(({ id, status }) => [id, status]),
      [
        ['executable', 'passed'],
        ['sandbox', 'failed'],
        ['doctor', 'unchecked'],
        ['model-access', 'unchecked'],
      ],
    );
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(
      (await f.invocations()).some(
        (call) => Array.isArray(call.args) && call.args.includes('--json'),
      ),
      false,
    );
  },
);

for (const healthy of [true, false]) {
  sandboxTest(
    `Claude Doctor ${healthy ? 'disposes sandbox state before authentication' : 'blocks authentication after sandbox failure'}`,
    async (t) => {
      const f = await fixture(t, 'agent.claudecode');
      await writeFile(
        f.executable,
        `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({args,state:process.env.CLAUDE_CONFIG_DIR}) + '\\n');
if (args[0] === '--help') console.log('--print --output-format --json-schema --permission-mode --tools --permission-prompts --verbose --no-session-persistence --disallowedTools --mcp-config --settings --strict-mcp-config');
else if (args[0] === 'auth') console.log(args.includes('--help') ? '--json' : JSON.stringify({loggedIn:true}));
else {
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  let input = '';
  process.stdin.on('data', (chunk) => input += chunk);
  process.stdin.on('end', () => {
    fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({input}) + '\\n');
    const replies = {initialize:{sandbox_enabled:${healthy}},get_settings:{effective:settings},get_hooks_listing:{hooks:[]},mcp_status:{mcpServers:[]}};
    for (const line of input.trim().split('\\n')) {
      const message = JSON.parse(line);
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:replies[message.request.subtype]}}));
    }
  });
}
`,
      );
      const context = f.context({ sandbox: 'read-only' });
      const result = await runDoctorRules(
        checkClaudeCodeAgent(context),
        context.signal,
      );
      assert.equal(result.checks[1].id, 'sandbox');
      assert.equal(result.checks[1].status, healthy ? 'passed' : 'failed');
      assert.equal(
        result.checks.find((check) => check.id === 'authentication')?.status,
        healthy ? 'passed' : 'unchecked',
      );
      const invocations = await f.invocations();
      const preparation = invocations.find(
        (call) => Array.isArray(call.args) && call.args.includes('-p'),
      );
      assert.equal(typeof preparation?.state, 'string');
      await assert.rejects(readdir(String(preparation?.state)), /ENOENT/);
      const input = invocations.find((call) => call.input)?.input;
      assert.equal(typeof input, 'string');
      assert.ok(
        String(input)
          .trim()
          .split('\n')
          .every((line) => object(JSON.parse(line)).type === 'control_request'),
      );
    },
  );
}

sandboxTest(
  'Claude Doctor uses the rule deadline and cleans cancelled sandbox state',
  async (t) => {
    const f = await fixture(t, 'agent.claudecode');
    await writeFile(
      f.executable,
      `const fs = require('node:fs');
if (process.argv.includes('--help')) console.log('--print --output-format --json-schema --permission-mode --tools --permission-prompts --verbose --no-session-persistence --disallowedTools --mcp-config --settings --strict-mcp-config');
else {
  fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({state:process.env.CLAUDE_CONFIG_DIR}) + '\\n');
  setInterval(() => {}, 1000);
}
`,
    );
    const context = f.context({ sandbox: 'read-only' });
    const rules = checkClaudeCodeAgent(context);
    const sandbox = rules.find((rule) => rule.id === 'sandbox');
    assert.ok(sandbox);
    sandbox.timeoutMs = 400;
    const result = await runDoctorRules(rules, context.signal);
    assert.equal(result.checks[1].status, 'failed');
    assert.match(result.checks[1].reason ?? '', /timed out after 400 ms/);
    assert.equal(
      result.checks.find((check) => check.id === 'authentication')?.status,
      'unchecked',
    );
    const [{ state }] = await f.invocations();
    assert.equal(typeof state, 'string');
    await assert.rejects(readdir(String(state)), /ENOENT/);
  },
);

sandboxTest(
  'DSH explicit Doctor checks generic help without booting the host profile',
  async (t) => {
    const f = await fixture(t, 'agent.dsh');
    await writeFile(
      f.executable,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({args}) + '\\n');
if (args.length !== 1 || args[0] !== '--help') throw new Error('Host profile must not boot');
console.log('--profile --patch');
`,
    );
    const context = f.context({ sandbox: 'read-only' });
    const result = await runDoctorRules(checkDshAgent(context), context.signal);
    assert.deepEqual(
      result.checks.map(({ id, status }) => [id, status]),
      [
        ['executable', 'passed'],
        ['sandbox', 'failed'],
        ['doctor', 'unchecked'],
        ['model-access', 'unchecked'],
      ],
    );
    assert.deepEqual(await f.invocations(), [{ args: ['--help'] }]);
    assert.equal(
      (await readdir(f.root)).some((entry) => entry.startsWith('dsh-sandbox-')),
      false,
    );
  },
);
