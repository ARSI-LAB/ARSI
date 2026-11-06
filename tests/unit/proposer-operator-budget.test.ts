import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { object } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';
import { requestOperatorAgent } from '../../src/plugins/proposer-operator/service.js';

test('operator stages derive separate scopes, preserve cancellation and reject an existing scope', async () => {
  const scopes: string[] = [];
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'parent',
    signal: new AbortController().signal,
    async invokeAgent(this: RuntimeContext, request) {
      assert.equal(request.maxModelCalls, this.scope?.limits.modelCalls);
      assert.deepEqual(request.input, {
        sourceFiles: { 'input.py': 'authorized source' },
      });
      assert.ok(typeof request.prompt === 'string');
      assert.equal(this.scope?.signal, this.signal);
      const id = this.scope!.id;
      scopes.push(id);
      return {};
    },
  });
  const request = {
    goal: 'Test',
    prompt: 'test',
    files: { 'input.py': 'authorized source' },
    outputSchema: { type: 'object' },
  };
  await requestOperatorAgent('diagnose', request, context);
  await requestOperatorAgent('generate', request, context);
  assert.notEqual(scopes[0], scopes[1]);
  await assert.rejects(
    requestOperatorAgent(
      'generate',
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
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'input.py' }),
                    }
                  : {
                      name: 'run_subagent',
                      arguments: JSON.stringify({
                        goal: 'Review the authorized source',
                        prompt: 'Read input.py and return JSON.',
                        filePaths: ['input.py'],
                        outputSchema: { type: 'object', required: ['finding'] },
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
          {
            agentRef: 'agent',
            goal: 'Review and propose a valid edit',
            prompt: 'Return JSON after inspecting authorized evidence.',
            files: { 'input.py': 'authorized source' },
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
  { result: { finding: 'reviewed source' } },
  { result: { accepted: true } },
];

test('operator stage completes tool continuations and delegated review beyond two model calls', async (t) => {
  const fixture = await modelFixture(continuedProposal);
  t.after(() => fixture.close());
  const result = await fixture.run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { accepted: true });
  assert.equal(fixture.requestCount(), 6);
  const budget = await fixture.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 6);
  const scopes = object(budget.scopes);
  assert.equal(Object.keys(scopes).length, 1);
  assert.equal(object(Object.values(scopes)[0]).modelCalls, 6);
  const calls = (await fixture.manager.facts.list('calls')).filter(
    (call) => call.bindingId === 'agent',
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.status === 'succeeded'));
  assert.ok(
    calls.some(
      (call) => object(call.input).goal === 'Review the authorized source',
    ),
  );
});

test('operator stage stops delegated model effects at its shared 24-call limit', async (t) => {
  const fixture = await modelFixture([
    { delegate: true },
    ...Array.from({ length: 23 }, (): Reply => ({ read: true })),
    { result: { finding: 'would exceed the shared stage limit' } },
  ]);
  t.after(() => fixture.close());
  await assert.rejects(fixture.run(), /Reflection modelCalls budget exceeded/);
  assert.equal(fixture.requestCount(), 24);
  const budget = await fixture.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 24);
  assert.equal(object(Object.values(object(budget.scopes))[0]).modelCalls, 24);
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

test('operator model stage bounds all calls with one propagated timeout without cancelling its parent', async () => {
  const parent = new AbortController();
  const context = new RuntimeContext().extend({
    experimentId: 'bounded-experiment',
    callId: 'bounded-call',
    signal: parent.signal,
    async invokeAgent(this: RuntimeContext) {
      assert.equal(this.scope?.limits.elapsedWallMs, 25);
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
    {
      goal: 'Bounded request',
      prompt: 'Return JSON',
      outputSchema: { type: 'object' },
    },
    context,
    25,
  );
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(pending, /timeout|aborted/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(parent.signal.aborted, false);
});
