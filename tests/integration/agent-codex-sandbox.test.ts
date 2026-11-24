import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  prepareCodexSandbox,
  validateCodexSandbox,
  validateCodexSandboxConfig,
} from '../../src/plugins/agent-codex/sandbox.js';
import { runCodexProcess } from '../../src/plugins/agent-codex/process.js';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';
import { object } from '../../src/shared/json.js';
import type { AgentProcessLauncher } from '../../src/contracts/index.js';

async function digest(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `native Codex ${mode} enforces filesystem effects without model requests`,
    { skip: process.platform !== 'linux' },
    async () => {
      const scratch = resolve('.scratch');
      await mkdir(scratch, { recursive: true });
      const root = await mkdtemp(join(scratch, 'codex-native-'));
      const platformTemporary = await mkdtemp(
        join(tmpdir(), 'codex-native-temp-'),
      );
      const directory = join(root, 'workspace');
      await mkdir(directory);
      await writeFile(join(directory, 'input'), 'readable');
      const configs = [
        join(
          process.env.CODEX_HOME ?? join(homedir(), '.codex'),
          'config.toml',
        ),
        resolve('.codex/config.toml'),
        '/etc/codex/config.toml',
      ];
      const before = await Promise.all(configs.map(digest));
      const signal = AbortSignal.timeout(30000);
      const launch: AgentProcessLauncher = async (spec, onLine) => {
        await runCommand(
          spec.executable,
          [
            '-c',
            `sandbox_workspace_write.writable_roots=${JSON.stringify([root])}`,
            ...spec.args,
          ],
          {
            signal,
            cwd: directory,
            env: spec.env,
            input: spec.input,
            onLine,
          },
        );
      };
      try {
        const settings = await prepareCodexSandbox({
          mode,
          executable: 'codex',
          directory,
          signal,
          launch,
        });
        let commandComplete = false;
        await runCodexProcess(
          'codex',
          JSON.stringify({
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: { name: 'arsi-native-test', version: '0.0.0' },
              capabilities: { experimentalApi: true },
            },
          }) + '\n',
          (line, send) => {
            const message = object(JSON.parse(line));
            assert.equal(message.error, undefined);
            if (message.id === 1) {
              send({ method: 'initialized' });
              send({
                id: 2,
                method: 'config/read',
                params: { cwd: directory },
              });
            } else if (message.id === 2) {
              const config = object(object(message.result).config);
              validateCodexSandboxConfig(config);
              assert.deepEqual(
                object(config.sandbox_workspace_write).writable_roots,
                [],
              );
              assert(
                Object.values(object(config.mcp_servers ?? {})).every(
                  (server) => object(server).enabled === false,
                ),
              );
              send({
                id: 3,
                method: 'thread/start',
                params: {
                  cwd: directory,
                  sandbox: mode,
                  ephemeral: true,
                  approvalPolicy: 'never',
                },
              });
            } else if (message.id === 3) {
              validateCodexSandbox(mode, directory, object(message.result));
              send({
                id: 4,
                method: 'command/exec',
                params: {
                  cwd: directory,
                  sandboxPolicy: settings.policy,
                  timeoutMs: 10000,
                  command: [
                    '/bin/sh',
                    '-c',
                    'cat input; for p in "$@"; do if (printf changed > "$p") 2>/dev/null; then printf "write=allowed\\n"; else printf "write=denied\\n"; fi; done',
                    'sandbox-test',
                    join(directory, 'inside'),
                    join(root, 'outside'),
                    join(platformTemporary, 'temporary'),
                  ],
                },
              });
            } else if (message.id === 4) {
              const result = object(message.result);
              assert.equal(result.exitCode, 0);
              assert.equal(
                result.stdout,
                mode === 'read-only'
                  ? 'readablewrite=denied\nwrite=denied\nwrite=denied\n'
                  : 'readablewrite=allowed\nwrite=denied\nwrite=allowed\n',
              );
              commandComplete = true;
              return true;
            }
          },
          launch,
          settings.config,
        );
        assert(commandComplete);
        await assert.rejects(access(join(root, 'outside')));
        assert.deepEqual(await Promise.all(configs.map(digest)), before);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(platformTemporary, { recursive: true, force: true });
      }
    },
  );
}

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `native Codex Agent ${mode} confines built-in patch and shell tools`,
    { skip: process.platform !== 'linux' },
    async () => {
      const { createServer } = await import('node:http');
      const { runSession } = await import(
        '../../src/plugins/agent-codex/session.js'
      );
      const { executablePath } = await import(
        '../../src/plugins/shared/doctor/executable.js'
      );
      const scratch = resolve('.scratch');
      await mkdir(scratch, { recursive: true });
      const root = await mkdtemp(join(scratch, 'codex-agent-native-'));
      const temporary = await mkdtemp(
        join(tmpdir(), 'codex-agent-native-temp-'),
      );
      const directory = join(root, 'workspace');
      await mkdir(directory);
      const configs = [
        join(
          process.env.CODEX_HOME ?? join(homedir(), '.codex'),
          'config.toml',
        ),
        resolve('.codex/config.toml'),
        '/etc/codex/config.toml',
      ];
      const before = await Promise.all(configs.map(digest));
      const paths = [
        join(directory, 'patch-inside'),
        join(root, 'patch-outside'),
        join(temporary, 'patch-temporary'),
      ];
      const toolOutputs = new Map<string, string>();
      let requests = 0;
      let serverFailure: unknown;
      const server = createServer(async (request, response) => {
        try {
          if (request.method === 'GET') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                data: [{ id: 'gpt-6.1-sol', object: 'model' }],
              }),
            );
            return;
          }
          let body = '';
          for await (const chunk of request) body += chunk.toString();
          const input = object(JSON.parse(body));
          assert(Array.isArray(input.input));
          for (const raw of input.input) {
            const item = object(raw);
            if (
              (item.type === 'custom_tool_call_output' ||
                item.type === 'function_call_output') &&
              typeof item.call_id === 'string' &&
              typeof item.output === 'string'
            )
              toolOutputs.set(item.call_id, item.output);
          }
          requests++;
          assert(requests <= 5);
          const item =
            requests <= paths.length
              ? {
                  id: `patch_${requests}`,
                  type: 'custom_tool_call',
                  call_id: `call_${requests}`,
                  name: 'apply_patch',
                  input: `*** Begin Patch\n*** Add File: ${paths[requests - 1]}\n+changed\n*** End Patch`,
                }
              : requests === 4
                ? {
                    id: 'shell_4',
                    type: 'function_call',
                    call_id: 'call_4',
                    name: 'exec_command',
                    arguments: JSON.stringify({
                      cmd: 'printf shell > shell-inside',
                      yield_time_ms: 1000,
                      max_output_tokens: 1000,
                    }),
                  }
                : {
                    id: 'answer_5',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      {
                        type: 'output_text',
                        text: '{"answer":"verified"}',
                        annotations: [],
                      },
                    ],
                  };
          const completed = {
            id: `response_${requests}`,
            object: 'response',
            created_at: 1,
            model: 'gpt-6.1-sol',
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          };
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            {
              type: 'response.created',
              response: { ...completed, status: 'in_progress', output: [] },
            },
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: completed },
          ])
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          response.end();
        } catch (error) {
          serverFailure = error;
          response.writeHead(500);
          response.end();
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const wrapper = join(root, 'codex-wrapper');
      const flags = [
        'model_provider="rsi-sandbox-test"',
        'model_providers.rsi-sandbox-test.name="RSI local verification"',
        `model_providers.rsi-sandbox-test.base_url="http://127.0.0.1:${address.port}/v1"`,
        'model_providers.rsi-sandbox-test.wire_api="responses"',
        'model_providers.rsi-sandbox-test.requires_openai_auth=false',
        'model_providers.rsi-sandbox-test.supports_websockets=false',
      ];
      const quote = (value: string): string =>
        "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec ${quote(await executablePath('codex', directory))} ${flags.map((value) => `-c ${quote(value)}`).join(' ')} "$@"\n`,
        { mode: 0o700 },
      );
      const signal = AbortSignal.timeout(30000);
      try {
        const output = await runSession({
          executable: wrapper,
          sandbox: mode,
          directory,
          model: 'gpt-6.1-sol',
          signal,
          request: {
            cwd: directory,
            goal: 'Execute the sandbox verification tools and return the requested JSON.',
            outputSchema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
          record() {},
          async launch(spec, onLine) {
            await runCommand(spec.executable, spec.args, {
              signal,
              cwd: directory,
              env: spec.env,
              input: spec.input,
              onLine,
            });
          },
        });
        assert.equal(serverFailure, undefined);
        assert.deepEqual(output, { answer: 'verified' });
        assert.equal(toolOutputs.size, 4);
        assert.match(
          toolOutputs.get('call_2') ?? '',
          /patch rejected|outside|denied|not permitted/i,
        );
        await assert.rejects(access(paths[1]!));
        if (mode === 'read-only') {
          for (const path of [
            paths[0]!,
            paths[2]!,
            join(directory, 'shell-inside'),
          ])
            await assert.rejects(access(path));
          assert.match(
            toolOutputs.get('call_1') ?? '',
            /read-only|rejected|denied/i,
          );
          assert.match(
            toolOutputs.get('call_3') ?? '',
            /read-only|rejected|denied/i,
          );
          assert.match(
            toolOutputs.get('call_4') ?? '',
            /read-only|denied|not permitted/i,
          );
        } else {
          assert.equal(await readFile(paths[0]!, 'utf8'), 'changed\n');
          assert.equal(await readFile(paths[2]!, 'utf8'), 'changed\n');
          assert.equal(
            await readFile(join(directory, 'shell-inside'), 'utf8'),
            'shell',
          );
        }
        assert.deepEqual(await Promise.all(configs.map(digest)), before);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
}
