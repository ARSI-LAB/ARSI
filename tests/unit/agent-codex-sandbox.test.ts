import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { configSchema } from '../../src/plugins/agent-codex/schema.js';
import { validate } from '../../src/shared/schema.js';
import {
  prepareCodexSandbox,
  validateCodexSandbox,
  validateCodexSandboxConfig,
} from '../../src/plugins/agent-codex/sandbox.js';
import type { AgentProcessSpec, JsonValue } from '../../src/contracts/index.js';

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `Codex ${mode} prepares native enforcement and disables host MCP servers`,
    { skip: process.platform !== 'linux' },
    async () => {
      validate(configSchema, { sandbox: mode }, 'Codex config');
      let probe: JsonValue | undefined;
      const launch = async (
        _spec: AgentProcessSpec,
        onLine: import('../../src/contracts/index.js').AgentLineHandler,
      ) => {
        const send = (message: JsonValue) => {
          probe = message;
        };
        await onLine(JSON.stringify({ id: 1, result: {} }), send);
        await onLine(
          JSON.stringify({
            id: 2,
            result: {
              config: {
                features: {
                  hooks: false,
                  plugins: false,
                  apps: false,
                  browser_use: false,
                  computer_use: false,
                  multi_agent: false,
                  multi_agent_v2: false,
                  remote_plugin: false,
                  skill_mcp_dependency_install: false,
                  code_mode: false,
                  code_mode_host: false,
                  code_mode_only: false,
                  js_repl: false,
                  js_repl_tools_only: false,
                  in_app_local_automation: false,
                },
                mcp_servers: {},
                sandbox_workspace_write: {
                  writable_roots: [],
                  network_access: true,
                },
                notify: [],
              },
            },
          }),
          send,
        );
        assert.equal((probe as { method: string }).method, 'command/exec');
        await onLine(JSON.stringify({ id: 3, result: { exitCode: 0 } }), send);
      };
      const settings = await prepareCodexSandbox({
        mode,
        directory: '/tmp/work',
        executable: process.execPath,
        signal: new AbortController().signal,
        launch,
      });
      assert(settings.config.includes('mcp_servers={}'));
      assert(settings.config.includes('features.hooks=false'));
      if (mode === 'workspace-write')
        assert.equal(settings.policy.networkAccess, true);
      assert.equal(
        settings.policy.type,
        mode === 'read-only' ? 'readOnly' : 'workspaceWrite',
      );
    },
  );
}

test('Codex rejects a wider effective sandbox before model submission', () => {
  assert.throws(
    () =>
      validateCodexSandbox('read-only', '/tmp/work', {
        sandbox: { type: 'dangerFullAccess' },
        approvalPolicy: 'never',
      }),
    /sandbox/,
  );
  assert.throws(
    () =>
      validateCodexSandbox('workspace-write', '/tmp/work', {
        sandbox: { type: 'workspaceWrite', writableRoots: ['/home'] },
        approvalPolicy: 'never',
      }),
    /sandbox/,
  );
});

test(
  'Codex rejects unavailable native sandbox enforcement',
  { skip: process.platform !== 'linux' },
  async () => {
    await assert.rejects(
      prepareCodexSandbox({
        mode: 'read-only',
        directory: '/tmp/work',
        executable: process.execPath,
        signal: new AbortController().signal,
        launch: async (_spec, onLine) => {
          await onLine(JSON.stringify({ id: 1, result: {} }), () => {});
          await onLine(
            JSON.stringify({
              id: 2,
              result: {
                config: {
                  features: {
                    hooks: false,
                    plugins: false,
                    apps: false,
                    browser_use: false,
                    computer_use: false,
                    multi_agent: false,
                    multi_agent_v2: false,
                    remote_plugin: false,
                    skill_mcp_dependency_install: false,
                    code_mode: false,
                    code_mode_host: false,
                    code_mode_only: false,
                    js_repl: false,
                    js_repl_tools_only: false,
                    in_app_local_automation: false,
                  },
                },
              },
            }),
            () => {},
          );
          await onLine(
            JSON.stringify({ id: 3, result: { exitCode: 1 } }),
            () => {},
          );
        },
      }),
      /sandbox/,
    );
  },
);

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `Codex ${mode} rejects a native downgrade before turn submission`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      let submitted = false;
      const features = Object.fromEntries(
        [
          'hooks',
          'plugins',
          'apps',
          'browser_use',
          'computer_use',
          'multi_agent',
          'multi_agent_v2',
          'remote_plugin',
          'skill_mcp_dependency_install',
          'code_mode',
          'code_mode_host',
          'code_mode_only',
          'js_repl',
          'js_repl_tools_only',
          'in_app_local_automation',
        ].map((name) => [name, false]),
      );
      const f = await agentFixture(async (_spec, onLine) => {
        const send = (message: JsonValue) => {
          if (
            message &&
            typeof message === 'object' &&
            !Array.isArray(message) &&
            message.method === 'turn/start'
          )
            submitted = true;
        };
        await onLine(JSON.stringify({ id: 1, result: {} }), send);
        await onLine(
          JSON.stringify({
            id: 4,
            result: {
              config: {
                features,
                mcp_servers: {},
                sandbox_workspace_write: { writable_roots: [] },
                notify: [],
              },
            },
          }),
          send,
        );
        await onLine(
          JSON.stringify({
            id: 2,
            result: {
              thread: { id: 'sandbox-test' },
              sandbox: { type: 'dangerFullAccess' },
              approvalPolicy: 'never',
            },
          }),
          send,
        );
      });
      t.after(() => f.close());
      const executable = join(f.root, 'codex-fixture.mjs');
      await writeFile(
        executable,
        `import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){const request=JSON.parse(line);let result;if(request.id===1)result={};else if(request.id===2)result={config:{features:${JSON.stringify(features)},mcp_servers:{},sandbox_workspace_write:{writable_roots:[]},notify:[]}};else if(request.id===3)result={exitCode:0};if(result)process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');}`,
      );
      const agent = await createAgentCodex(
        { executable, sandbox: mode },
        f.context,
      );
      await assert.rejects(f.execute(agent), /sandbox/);
      assert.equal(submitted, false);
    },
  );
}

test('Codex rejects inherited MCP tools and extra writable roots in explicit mode', () => {
  const features = Object.fromEntries(
    [
      'hooks',
      'plugins',
      'apps',
      'browser_use',
      'computer_use',
      'multi_agent',
      'multi_agent_v2',
      'remote_plugin',
      'skill_mcp_dependency_install',
      'code_mode',
      'code_mode_host',
      'code_mode_only',
      'js_repl',
      'js_repl_tools_only',
      'in_app_local_automation',
    ].map((key) => [key, false]),
  );
  assert.throws(
    () =>
      validateCodexSandboxConfig({
        features,
        mcp_servers: { host: { command: 'host-tool' } },
        sandbox_workspace_write: { writable_roots: [] },
        notify: [],
      }),
    /MCP/,
  );
  assert.throws(
    () =>
      validateCodexSandboxConfig({
        features,
        mcp_servers: {},
        sandbox_workspace_write: { writable_roots: ['/home'] },
        notify: [],
      }),
    /writable/,
  );
});
