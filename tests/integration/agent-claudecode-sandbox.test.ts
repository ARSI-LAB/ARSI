import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSession } from '../../src/plugins/agent-claudecode/session.js';
import { executablePath } from '../../src/plugins/shared/doctor/executable.js';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';
import type { JsonObject } from '../../src/contracts/index.js';

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

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

for (const sandbox of ['read-only', 'workspace-write'] as const) {
  test(
    `native Claude Code enforces ${sandbox}`,
    { timeout: 60000 },
    async (t) => {
      assert.equal(
        process.platform,
        'linux',
        'Native sandbox verification requires Linux.',
      );
      const executable = await realpath(
        await executablePath(
          process.env.CLAUDE_SANDBOX_EXECUTABLE ?? 'claude',
          process.cwd(),
        ),
      );
      const sourceConfig =
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
      const settings = [
        join(sourceConfig, 'settings.json'),
        join(homedir(), '.claude.json'),
      ];
      const before = await Promise.all(settings.map(digest));
      await mkdir('.scratch', { recursive: true });
      const root = await mkdtemp(
        join(process.cwd(), '.scratch', 'native-claude-sandbox-'),
      );
      const temporary = await mkdtemp(join(tmpdir(), 'native-claude-sandbox-'));
      const project = join(root, 'project');
      const outside = join(root, 'outside');
      await mkdir(project);
      await mkdir(outside);
      t.after(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(temporary, { recursive: true, force: true });
      });
      await writeFile(join(project, 'input.txt'), 'readable native input');
      await writeFile(
        join(project, 'document.pdf'),
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF',
      );
      const rendererDirectory = join(root, 'renderer');
      await mkdir(rendererDirectory);
      await writeFile(
        join(rendererDirectory, 'pdftoppm'),
        '#!/bin/sh\ncase "$1" in -v|--version) exit 0;; esac\nprintf rendered > ' +
          quote(join(temporary, 'read-rendered')) +
          '\nexit 1\n',
        { mode: 0o700 },
      );
      const fixtureConfig = join(root, 'native-config');
      await mkdir(fixtureConfig);
      await writeFile(
        join(fixtureConfig, 'settings.json'),
        JSON.stringify({
          sandbox: { filesystem: { allowWrite: [outside] } },
          permissions: {
            additionalDirectories: [outside],
            allow: ['Write', 'Edit', 'Agent'],
          },
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'touch ' + quote(join(outside, 'hook-ran')),
                  },
                ],
              },
            ],
          },
        }),
      );
      const inheritedConfig = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = fixtureConfig;
      t.after(() => {
        if (inheritedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = inheritedConfig;
      });
      const fixtureBefore = await digest(join(fixtureConfig, 'settings.json'));
      const toolResults: unknown[] = [];
      const taskTimeline: string[] = [];
      let messages = 0;
      let declaredTools: string[] = [];
      const bash = `printf allowed > ${quote(join(project, 'allowed'))}; probe_file=$(mktemp); printf allowed > \"$probe_file\"; cat \"$probe_file\" > ${quote(join(project, 'temporary-result'))}; rm \"$probe_file\"; printf blocked > ${quote(join(outside, 'blocked'))}`;
      const mutations =
        sandbox === 'workspace-write'
          ? [
              { id: 'probe', name: 'Bash', input: { command: bash } },
              {
                id: 'escape',
                name: 'Bash',
                input: {
                  command: `printf blocked > ${quote(join(outside, 'escaped'))}`,
                  dangerouslyDisableSandbox: true,
                },
              },
            ]
          : [
              {
                id: 'write',
                name: 'Write',
                input: {
                  file_path: join(project, 'blocked'),
                  content: 'blocked',
                },
              },
              {
                id: 'shell',
                name: 'Bash',
                input: {
                  command: `printf blocked > ${quote(join(temporary, 'blocked'))}`,
                },
              },
            ];
      const requested = [
        ...(sandbox === 'read-only'
          ? [
              {
                id: 'pdf',
                name: 'Read',
                input: { file_path: join(project, 'document.pdf'), pages: '1' },
              },
            ]
          : []),
        {
          id: 'read',
          name: sandbox === 'read-only' ? 'Grep' : 'Read',
          input:
            sandbox === 'read-only'
              ? {
                  path: join(project, 'input.txt'),
                  pattern: '.',
                  output_mode: 'content',
                }
              : { file_path: join(project, 'input.txt') },
        },
        {
          id: 'external-write',
          name: 'Write',
          input: { file_path: join(outside, 'file-tool'), content: 'blocked' },
        },
        ...mutations,
      ];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        if (!req.url?.includes('/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const payload = JSON.parse(body) as JsonObject;
        if (req.url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"input_tokens":1}');
          return;
        }
        messages++;
        taskTimeline.push('model-request');
        declaredTools = ((payload.tools as JsonObject[]) ?? []).map((tool) =>
          String(tool.name),
        );
        for (const message of (payload.messages as JsonObject[]) ?? []) {
          if (message.role === 'user' && Array.isArray(message.content))
            toolResults.push(
              ...message.content.filter(
                (item) =>
                  item !== null &&
                  typeof item === 'object' &&
                  'type' in item &&
                  item.type === 'tool_result',
              ),
            );
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (name: string, value: unknown): void => {
          res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
        };
        event('message_start', {
          type: 'message_start',
          message: {
            id: `message-${messages}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        const calls =
          messages === 1
            ? requested
            : messages === 2
              ? [
                  {
                    id: 'result',
                    name: 'StructuredOutput',
                    input: { answer: 'ok' },
                  },
                ]
              : [];
        if (calls.length) {
          for (const [index, tool] of calls.entries()) {
            event('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: tool.id,
                name: tool.name,
                input: {},
              },
            });
            event('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(tool.input),
              },
            });
            event('content_block_stop', { type: 'content_block_stop', index });
          }
        } else {
          event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          event('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'Native sandbox probe finished.',
            },
          });
          event('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        event('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: calls.length ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 10 },
        });
        event('message_stop', { type: 'message_stop' });
        res.end();
      });
      server.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const signal = AbortSignal.timeout(30000);
      const result = await runSession({
        config: { executable, sandbox, model: 'claude-sonnet-4-5' },
        directory: project,
        request: {
          cwd: project,
          goal: 'Exercise the supplied native probes and return the requested result.',
          outputSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
        signal,
        record(observation) {
          if (observation.event.type === 'task.submitted')
            taskTimeline.push('task-submitted');
        },
        async launch(spec, onLine) {
          await runCommand(spec.executable, spec.args, {
            signal,
            cwd: project,
            input: spec.input,
            onLine,
            env: {
              ...spec.env,
              PATH: rendererDirectory + ':' + spec.env?.PATH,
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
              ANTHROPIC_AUTH_TOKEN: 'native-sandbox-fixture',
              ANTHROPIC_API_KEY: 'native-sandbox-fixture',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            },
          });
        },
      });
      assert.deepEqual(result, { answer: 'ok' });
      assert.equal(taskTimeline[0], 'task-submitted');
      assert.equal(
        taskTimeline.filter((entry) => entry === 'task-submitted').length,
        1,
      );
      assert.ok(messages >= 2);
      assert.ok(toolResults.length > 0);
      assert.ok(JSON.stringify(toolResults).includes('readable native input'));
      for (const file of ['hook-ran', 'file-tool', 'escaped'])
        await assert.rejects(readFile(join(outside, file)), { code: 'ENOENT' });
      assert.equal(
        await digest(join(fixtureConfig, 'settings.json')),
        fixtureBefore,
      );
      assert.equal(declaredTools.includes('Write'), false);
      assert.equal(declaredTools.includes('Edit'), false);
      assert.equal(declaredTools.includes('Agent'), false);
      await assert.rejects(readFile(join(outside, 'blocked')), {
        code: 'ENOENT',
      });
      if (sandbox === 'workspace-write') {
        assert.ok(declaredTools.includes('Bash'));
        assert.equal(
          await readFile(join(project, 'allowed'), 'utf8'),
          'allowed',
        );
        assert.equal(
          await readFile(join(project, 'temporary-result'), 'utf8'),
          'allowed',
        );
      } else {
        assert.equal(declaredTools.includes('Bash'), false);
        assert.equal(declaredTools.includes('Read'), false);
        await assert.rejects(readFile(join(project, 'blocked')), {
          code: 'ENOENT',
        });
        await assert.rejects(readFile(join(temporary, 'read-rendered')), {
          code: 'ENOENT',
        });
        await assert.rejects(readFile(join(temporary, 'blocked')), {
          code: 'ENOENT',
        });
      }
      assert.deepEqual(
        await Promise.all(settings.map(digest)),
        before,
        'Host configuration changed.',
      );
      const version = await runCommand(executable, ['--version'], {
        signal: AbortSignal.timeout(5000),
      });
      t.diagnostic(
        `${version.stdout.trim()}, ${sandbox}, native tools exercised with a local deterministic API fixture.`,
      );
    },
  );
}
