import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { object } from '../../src/shared/json.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { managerFixture } from '../helpers/manager-fixture.js';
import { requestOperatorAgent } from '../../src/plugins/proposer-operator/service.js';

async function projectContext(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-operator-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new RuntimeContext().extend({
    directory,
    artifacts: new FileArtifacts(join(directory, 'artifacts')),
  });
}

test('operator stages derive separate scopes, preserve cancellation and reject an existing scope', async (t) => {
  const scopes: string[] = [];
  const context = (await projectContext(t)).extend({
    experimentId: 'experiment',
    callId: 'parent',
    signal: new AbortController().signal,
    async invokeAgent(this: RuntimeContext, binding, request) {
      assert.equal(binding, 'agent');
      assert.equal(this.scope?.limits.modelCalls, undefined);
      assert.ok(typeof request.cwd === 'string');
      assert.deepEqual(Object.keys(request).sort(), [
        'cwd',
        'goal',
        'outputSchema',
      ]);
      assert.equal(
        await readFile(
          join(request.cwd, 'context/sources/kernels/add.py'),
          'utf8',
        ),
        'authorized source',
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(request.cwd, 'context/input.json'), 'utf8'),
        ),
        {
          hardwareContext: 'authorized hardware context',
          sourcePath: 'kernels/add.py',
          sourceFiles: ['kernels/add.py'],
          editablePaths: ['kernels/add.py'],
        },
      );
      assert.match(
        await readFile(join(request.cwd, 'AGENTS.md'), 'utf8'),
        /context\/input\.json/,
      );
      assert.equal(this.scope?.signal, this.signal);
      const id = this.scope!.id;
      scopes.push(id);
      return {};
    },
  });
  const request = {
    goal: 'Test',
    prompt: 'test',
    sourcePath: 'kernels/add.py',
    sourceFiles: ['kernels/add.py'],
    editablePaths: ['kernels/add.py'],
    files: { 'context/sources/kernels/add.py': 'authorized source' },
    input: { hardwareContext: 'authorized hardware context' },
    outputSchema: { type: 'object' },
  };
  await requestOperatorAgent('diagnose', 'agent', request, context);
  await requestOperatorAgent('generate', 'agent', request, context);
  assert.notEqual(scopes[0], scopes[1]);
  await assert.rejects(
    requestOperatorAgent(
      'generate',
      'agent',
      request,
      context.extend({
        scope: {
          id: 'outer',
          signal: context.signal,
          limits: { modelCalls: 100, evidenceBytes: 100 },
        },
      }),
    ),
    /scope/i,
  );
});

test('operator stages forward authorized snapshots above 2 MiB without an implicit evidence cap', async (t) => {
  const source = 'x'.repeat(2 * 1024 * 1024 + 1);
  const context = (await projectContext(t)).extend({
    experimentId: 'large-snapshot',
    callId: 'generate',
    signal: new AbortController().signal,
    async invokeAgent(this: RuntimeContext, _binding, request) {
      assert.equal(
        await readFile(
          join(request.cwd, 'context/sources/kernels/add.py'),
          'utf8',
        ),
        source,
      );
      assert.equal(this.scope?.limits.evidenceBytes, undefined);
      return { accepted: true };
    },
  });
  assert.deepEqual(
    await requestOperatorAgent(
      'generate',
      'agent',
      {
        goal: 'Inspect the complete authorized source',
        prompt: 'Return JSON',
        sourcePath: 'kernels/add.py',
        sourceFiles: ['kernels/add.py'],
        editablePaths: ['kernels/add.py'],
        files: { 'context/sources/kernels/add.py': source },
        input: {},
        outputSchema: { type: 'object' },
      },
      context,
    ),
    { accepted: true },
  );
});

test('operator stage timeout can be disabled while parent cancellation still propagates', async (t) => {
  const parent = new AbortController();
  const cancelled = new Error('Explicit parent cancellation');
  const context = (await projectContext(t)).extend({
    experimentId: 'no-local-deadline',
    callId: 'generate',
    signal: parent.signal,
    async invokeAgent(this: RuntimeContext) {
      assert.equal(this.scope?.limits.elapsedWallMs, undefined);
      return new Promise<never>((_resolve, reject) => {
        this.signal.addEventListener(
          'abort',
          () => reject(this.signal.reason),
          {
            once: true,
          },
        );
      });
    },
  });
  const pending = requestOperatorAgent(
    'generate',
    'agent',
    {
      goal: 'Test cancellation',
      prompt: 'Return JSON',
      input: {},
      sourcePath: 'kernels/add.py',
      sourceFiles: ['kernels/add.py'],
      editablePaths: ['kernels/add.py'],
      files: {},
      outputSchema: { type: 'object' },
    },
    context,
    0,
  );
  parent.abort(cancelled);
  await assert.rejects(pending, (error) => error === cancelled);
});

type Reply = { read: true } | { delegate: true } | { result: JsonObject };

async function modelFixture(replies: Reply[], modelCalls = 64) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the local model request without retaining its prompt.
    }
    const reply = replies[requests++];
    if (!reply) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Unexpected model call' } }),
      );
      return;
    }
    const tool = 'read' in reply || 'delegate' in reply;
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `tool-${requests}`,
              type: 'function',
              function:
                'read' in reply
                  ? {
                      name: 'read',
                      arguments: JSON.stringify({
                        path: 'context/sources/kernels/add.py',
                      }),
                    }
                  : {
                      name: 'subagent',
                      arguments: JSON.stringify({
                        agent: 'operator-reviewer',
                        task: 'Review the authorized source',
                      }),
                    },
            },
          ],
        }
      : { role: 'assistant', content: JSON.stringify(reply.result) };
    const chunk = (value: object, reason: string | null): string =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      chunk(delta, null) +
        chunk({}, tool ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previous = process.env.RSI_OPERATOR_BUDGET_KEY;
  process.env.RSI_OPERATOR_BUDGET_KEY = 'local-fixture-key';
  const closeServer = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (previous === undefined) delete process.env.RSI_OPERATOR_BUDGET_KEY;
    else process.env.RSI_OPERATOR_BUDGET_KEY = previous;
  };
  let manager: Awaited<ReturnType<typeof managerFixture>>;
  try {
    manager = await managerFixture(
      (context) =>
        requestOperatorAgent(
          'generate',
          'agent',
          {
            goal: 'Review and propose a valid edit',
            prompt: 'Return JSON after inspecting authorized evidence.',
            sourcePath: 'kernels/add.py',
            sourceFiles: ['kernels/add.py'],
            editablePaths: ['kernels/add.py'],
            files: { 'context/sources/kernels/add.py': 'authorized source' },
            input: {},
            outputSchema: { type: 'object' },
          },
          context,
          30000,
        ),
      {
        budget: { modelCalls, elapsedWallMs: 30000 },
        plugins: [piDefinition],
        bindings: {
          agent: {
            plugin: 'agent.pi',
            config: {
              model: 'fixture',
              base_url: `http://127.0.0.1:${address.port}/v1`,
              api_key: '${RSI_OPERATOR_BUDGET_KEY}',
              timeoutMs: 3000,
            },
          },
        },
      },
    );
  } catch (error) {
    await closeServer();
    throw error;
  }
  return {
    ...manager,
    requestCount: () => requests,
    async close() {
      try {
        await manager.dispose();
      } finally {
        await closeServer();
      }
    },
  };
}

const continuedProposal: Reply[] = [
  { read: true },
  { read: true },
  { delegate: true },
  { read: true },
  { result: { findings: 'reviewed source' } },
  { result: { accepted: true } },
];

test('operator stage completes tool continuations and delegated review beyond 24 model calls', async (t) => {
  const fixture = await modelFixture([
    { delegate: true },
    ...Array.from({ length: 24 }, (): Reply => ({ read: true })),
    { result: { findings: 'reviewed source' } },
    { result: { accepted: true } },
  ]);
  t.after(() => fixture.close());
  const result = await fixture.run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { accepted: true });
  assert.equal(fixture.requestCount(), 27);
  const budget = await fixture.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 27);
  const scopes = object(budget.scopes);
  assert.equal(Object.keys(scopes).length, 1);
  assert.equal(object(Object.values(scopes)[0]).modelCalls, 27);
  const calls = (await fixture.manager.facts.list('calls')).filter(
    (call) => call.bindingId === 'agent',
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.status === 'succeeded'));
  const delegate = calls.find(
    (call) => object(call.input).role === 'operator-reviewer',
  );
  assert.ok(delegate);
  const parent = calls.find((call) => call.callId === delegate.parentCallId);
  assert.ok(parent);
  assert.equal(object(delegate.input).goal, 'Review the authorized source');
  assert.equal(object(delegate.input).cwd, object(parent.input).cwd);
});

test('lower Manager model budget stops an operator stage before its next external request', async (t) => {
  const fixture = await modelFixture(continuedProposal, 4);
  t.after(() => fixture.close());
  await assert.rejects(fixture.run(), /Budget exceeded: modelCalls/);
  assert.equal(fixture.requestCount(), 4);
  const budget = await fixture.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 4);
  assert.equal(object(Object.values(object(budget.scopes))[0]).modelCalls, 4);
});

test('operator model stage bounds all calls with one propagated timeout without cancelling its parent', async (t) => {
  const parent = new AbortController();
  let entered = false;
  const context = (await projectContext(t)).extend({
    experimentId: 'bounded-experiment',
    callId: 'bounded-call',
    signal: parent.signal,
    async invokeAgent(this: RuntimeContext) {
      assert.equal(this.scope?.limits.elapsedWallMs, 250);
      entered = true;
      return new Promise<never>((_resolve, reject) => {
        this.signal.addEventListener(
          'abort',
          () => reject(this.signal.reason),
          { once: true },
        );
      });
    },
  });
  const pending = requestOperatorAgent(
    'generate',
    'agent',
    {
      goal: 'Bounded request',
      prompt: 'Return JSON',
      sourcePath: 'kernels/add.py',
      sourceFiles: ['kernels/add.py'],
      editablePaths: ['kernels/add.py'],
      files: {},
      input: {},
      outputSchema: { type: 'object' },
    },
    context,
    250,
  );
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(pending, /timeout|aborted/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(entered);
  assert.equal(parent.signal.aborted, false);
});
