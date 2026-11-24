import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareDshSandbox } from '../../src/plugins/agent-dsh/sandbox.js';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';
import { runDoctorRules } from '../../src/runtime/doctor/rules.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';
import { object } from '../../src/shared/json.js';

async function hostConfiguration(): Promise<string> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const values: string[] = [];
  for (const path of [
    'cordis.patch.yml',
    'profiles/headless/package.json',
    'profiles/headless/cordis.patch.yml',
    'profiles/headless/cordis.yml',
  ]) {
    try {
      values.push(
        createHash('sha256')
          .update(await readFile(join(home, path)))
          .digest('hex'),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      values.push('absent');
    }
  }
  return values.join('\n');
}

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `DSH native ${mode} confines shell and file tools without changing host configuration`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      const parent = resolve('.scratch');
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'dsh-native-'));
      const temp = await mkdtemp(join(tmpdir(), 'dsh-native-'));
      t.after(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(temp, { recursive: true, force: true });
      });
      const workspace = join(root, 'workspace');
      const artifacts = join(root, 'artifacts');
      await mkdir(workspace);
      await mkdir(artifacts);
      await writeFile(join(workspace, 'input'), 'readable');
      const before = await hostConfiguration();
      const signal = AbortSignal.timeout(30000);
      const prepared = await prepareDshSandbox({
        executable: process.env.DSH_EXECUTABLE ?? 'dsh',
        mode,
        directory: workspace,
        artifacts,
        signal,
      });
      t.after(() => prepared.dispose());
      const patches = prepared.patches;
      const probePath = join(artifacts, 'probe.mjs');
      await writeFile(
        probePath,
        `
export const name = 'rsi-native-probe';
export const inject = ['rsiSandboxReady', 'shell', 'fs', 'tools'];
export async function apply(ctx) {
  try {
    const checks = {};
    const allowed = new Set(['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill']);
    if (ctx.tools.schemas().some((tool) => !allowed.has(tool.name))) throw new Error('Unconfined tool remained visible');
    checks.read = await ctx.fs.readText(await ctx.fs.resolve(${JSON.stringify(join(workspace, 'input'))}));
    for (const [name, directory] of Object.entries(${JSON.stringify({ inside: workspace, outside: root, temp })})) {
      const target = directory + '/file-' + name;
      try { await ctx.fs.writeText(await ctx.fs.resolve(target), 'probe'); checks['file_' + name] = true; }
      catch (error) { if (error.code !== 'FS_SANDBOX_DENIED') throw error; checks['file_' + name] = false; }
      const command = 'mkdir -p ' + JSON.stringify(directory) + ' && printf probe > ' + JSON.stringify(directory + '/shell-' + name);
      const handle = await ctx.shell.execute(ctx.shell.resolve({ command, workdir: ${JSON.stringify(workspace)}, timeoutMs: 5000 }));
      const result = await handle.result();
      if (result.sandbox?.enforcement !== 'full') throw new Error('Native shell did not fully enforce sandbox');
      checks['shell_' + name] = result.exitCode === 0;
    }
    console.log('RSI_DSH_NATIVE=' + JSON.stringify(checks));
    ctx.appExit(0);
  } catch (error) { console.error(error); ctx.appExit(1); }
}
`,
      );
      patches.push(
        { id: 'headless-runner', disabled: true },
        { insert: [{ id: 'rsi-native-probe', name: probePath }] },
      );
      const patchPath = join(artifacts, 'launch.json');
      await writeFile(patchPath, JSON.stringify(patches));
      const result = await runCommand(
        process.env.DSH_EXECUTABLE ?? 'dsh',
        ['--profile', 'headless', '--patch', patchPath, '--json', '-'],
        {
          signal,
          cwd: workspace,
          input: '',
          env: prepared.env,
        },
      );
      const line = result.stdout
        .split('\n')
        .find((item) => item.startsWith('RSI_DSH_NATIVE='));
      assert.ok(line, result.stderr);
      const checks = object(JSON.parse(line.slice('RSI_DSH_NATIVE='.length)));
      assert.deepEqual(checks, {
        read: 'readable',
        file_inside: mode === 'workspace-write',
        shell_inside: mode === 'workspace-write',
        file_outside: false,
        shell_outside: false,
        file_temp: mode === 'workspace-write',
        shell_temp: mode === 'workspace-write',
      });
      assert.equal(await hostConfiguration(), before);
    },
  );
}

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(
    `DSH Agent service applies ${mode} to model-requested native tools`,
    { timeout: 45000 },
    async (t) => {
      const { createServer } = await import('node:http');
      const { agentFixture } = await import('../fixtures/agent-execution.js');
      const { createAgentDsh } = await import(
        '../../src/plugins/agent-dsh/service.js'
      );
      const scratch = resolve('.scratch');
      await mkdir(scratch, { recursive: true });
      const root = await mkdtemp(join(scratch, 'dsh-service-'));
      const workspace = join(root, 'workspace');
      const temporary = await mkdtemp(join(tmpdir(), 'dsh-service-'));
      await mkdir(workspace);
      await writeFile(join(workspace, 'input.txt'), 'readable');
      t.after(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(temporary, { recursive: true, force: true });
      });
      const before = await hostConfiguration();
      const nativeHome = process.env.DSH_HOME;
      process.env.DSH_HOME = join(root, 'private-home');
      t.after(() => {
        if (nativeHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = nativeHome;
      });
      let requests = 0;
      const tools: string[] = [];
      const toolResults: unknown[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const payload = object(JSON.parse(body));
        const main =
          Array.isArray(payload.tools) &&
          payload.tools.some((raw) => object(raw).name === 'bash');
        if (main) requests++;
        if (Array.isArray(payload.tools))
          for (const raw of payload.tools) tools.push(String(object(raw).name));
        if (Array.isArray(payload.messages))
          for (const raw of payload.messages) {
            const message = object(raw);
            if (Array.isArray(message.content))
              toolResults.push(
                ...message.content.filter(
                  (part) =>
                    part !== null &&
                    typeof part === 'object' &&
                    !Array.isArray(part) &&
                    part.type === 'tool_result',
                ),
              );
          }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (type: string, value: unknown): void => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
        };
        event('message_start', {
          type: 'message_start',
          message: {
            id: `probe-${requests}`,
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        const calls =
          main && requests === 1
            ? [
                {
                  id: 'read',
                  name: 'read',
                  input: { file_path: join(workspace, 'input.txt') },
                },
                {
                  id: 'inside',
                  name: 'write',
                  input: {
                    file_path: join(workspace, 'file-inside'),
                    content: 'probe',
                  },
                },
                {
                  id: 'outside',
                  name: 'write',
                  input: {
                    file_path: join(root, 'file-outside'),
                    content: 'probe',
                  },
                },
                {
                  id: 'temp',
                  name: 'write',
                  input: {
                    file_path: join(temporary, 'file-temp'),
                    content: 'probe',
                  },
                },
                {
                  id: 'shell',
                  name: 'bash',
                  input: {
                    command: `printf probe > ${JSON.stringify(join(workspace, 'shell-inside'))}; mkdir -p ${JSON.stringify(temporary)}; printf probe > ${JSON.stringify(join(temporary, 'shell-temp'))}; cat ${JSON.stringify(join(temporary, 'shell-temp'))} > ${JSON.stringify(join(workspace, 'shell-temp-result'))}; printf probe > ${JSON.stringify(join(root, 'shell-outside'))}`,
                    description: 'Check native shell boundaries',
                  },
                },
                {
                  id: 'escalate',
                  name: 'write',
                  input: {
                    file_path: join(root, 'escalated'),
                    content: 'probe',
                    sandbox_permissions: 'danger-full-access',
                    justification: 'Native test escalation must be rejected',
                  },
                },
                {
                  id: 'shell-escalate',
                  name: 'bash',
                  input: {
                    command: `printf probe > ${JSON.stringify(join(root, 'shell-escalated'))}`,
                    description: 'Check native escalation rejection',
                    sandbox_permissions: 'danger-full-access',
                    justification: 'Native shell escalation must be rejected',
                  },
                },
              ]
            : [];
        if (calls.length) {
          for (const [index, call] of calls.entries()) {
            event('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: {},
              },
            });
            event('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(call.input),
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
            delta: { type: 'text_delta', text: '{"answer":"ok"}' },
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
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
      });
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const fixture = await agentFixture(async (spec, onLine, context) => {
        const native = await runCommand(spec.executable, spec.args, {
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]),
          cwd: workspace,
          env: {
            ...process.env,
            ...spec.env,
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
            DEEPSEEK_API_KEY: 'native-test-only',
            DSH_TELEMETRY_DISABLED: '1',
          },
          input: spec.input,
        });
        for (const line of native.stdout.split('\n'))
          if (line.trim()) await onLine(line, () => {});
      });
      t.after(() => fixture.close());
      const agent = await createAgentDsh(
        { executable: process.env.DSH_EXECUTABLE ?? 'dsh', sandbox: mode },
        fixture.context,
      );
      assert.deepEqual(
        await fixture.execute(agent, { ...fixture.request, cwd: workspace }),
        { answer: 'ok' },
      );
      const records = await readAgentRecords(
        fixture.context.directory,
        0,
        100,
        true,
      );
      assert.equal(records.submitted?.event.type, 'task.submitted');
      assert.ok(records.finalResponses.length > 0);
      assert.deepEqual(records.items.at(-1)?.event, {
        type: 'run.finished',
        status: 'completed',
        nativeStatus: 'completed',
      });
      assert.equal(requests, 2);
      assert.ok(tools.includes('read') && tools.includes('bash'));
      assert.ok(!tools.includes('write') && !tools.includes('edit'));
      assert.ok(
        !tools.includes('subagent') && !tools.includes('exit_plan_mode'),
      );
      assert.ok(JSON.stringify(toolResults).includes('readable'));
      for (const path of [
        join(root, 'file-outside'),
        join(root, 'shell-outside'),
        join(root, 'escalated'),
        join(root, 'shell-escalated'),
      ])
        await assert.rejects(readFile(path), { code: 'ENOENT' });
      for (const path of [
        join(workspace, 'file-inside'),
        join(temporary, 'file-temp'),
      ])
        await assert.rejects(readFile(path), { code: 'ENOENT' });
      for (const path of [
        join(workspace, 'shell-inside'),
        join(workspace, 'shell-temp-result'),
      ]) {
        if (mode === 'workspace-write')
          assert.equal(await readFile(path, 'utf8'), 'probe');
        else await assert.rejects(readFile(path), { code: 'ENOENT' });
      }
      if (nativeHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = nativeHome;
      assert.equal(await hostConfiguration(), before);
    },
  );
}

test(
  'DSH explicit sandbox leaves absent and legacy host profiles untouched',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-source-profile-'));
    const source = join(root, 'source');
    const workspace = join(root, 'workspace');
    const artifacts = join(root, 'artifacts');
    await mkdir(workspace);
    await mkdir(artifacts);
    const inherited = process.env.DSH_HOME;
    process.env.DSH_HOME = source;
    t.after(async () => {
      if (inherited === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = inherited;
      await rm(root, { recursive: true, force: true });
    });
    const options = {
      executable: process.env.DSH_EXECUTABLE ?? 'dsh',
      mode: 'read-only' as const,
      directory: workspace,
      artifacts,
      signal: AbortSignal.timeout(20000),
    };
    const absent = await prepareDshSandbox(options);
    assert.notEqual(absent.env.DSH_HOME, source);
    await absent.dispose();

    const { createRuntime } = await import('../../src/runtime/context.js');
    const { checkDshAgent } = await import(
      '../../src/plugins/agent-dsh/doctor.js'
    );
    const runtime = await createRuntime({
      homeDirectory: false,
      rootDirectory: root,
      directory: join(root, 'runtime'),
    });
    t.after(() => runtime.dispose());
    const binding = {
      name: 'agent',
      pluginId: 'agent.dsh',
      definition: runtime.registry.get('agent.dsh'),
      config: { executable: options.executable, sandbox: 'read-only' },
    };
    const report = await runDoctorRules(
      checkDshAgent({
        binding,
        recipe: {
          application: binding,
          bindings: { agent: binding },
          policyConfig: {},
        },
        registry: runtime.registry,
        runtime: runtime.context,
        directory: artifacts,
        signal: options.signal,
      }),
      options.signal,
    );
    assert.deepEqual(
      report.checks.map(({ id, status }) => ({ id, status })),
      [
        { id: 'executable', status: 'passed' },
        { id: 'sandbox', status: 'passed' },
        { id: 'doctor', status: 'unchecked' },
        { id: 'model-access', status: 'unchecked' },
      ],
    );
    await assert.rejects(
      readFile(join(source, 'profiles/headless/package.json')),
      { code: 'ENOENT' },
    );
    const profile = join(source, 'profiles', 'headless');
    await mkdir(profile, { recursive: true });
    const packageText = JSON.stringify({
      name: 'legacy-headless',
      private: true,
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
        },
      },
    });
    await writeFile(join(profile, 'package.json'), packageText);
    await writeFile(
      join(profile, 'cordis.yml'),
      '# legacy root must stay intact\n[]\n',
    );
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
    const before = await hostConfiguration();
    const legacy = await prepareDshSandbox(options);
    await legacy.dispose();
    assert.equal(
      await readFile(join(profile, 'package.json'), 'utf8'),
      packageText,
    );
    assert.equal(await hostConfiguration(), before);
    await assert.rejects(
      prepareDshSandbox({
        ...options,
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
      /cancelled/,
    );
    assert.equal(await hostConfiguration(), before);
  },
);
