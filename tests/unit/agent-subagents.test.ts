import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject, RuntimeContext } from '../../src/contracts/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

type Reply =
  | { result: JsonObject }
  | { tool: string; arguments: JsonObject }
  | { error: string }
  | null;

const delegated: JsonObject = {
  goal: 'Investigate the chosen question',
  prompt: 'Inspect the supplied files and report your findings as JSON.',
  input: { custom: ['cross-target comparison', { hypothesis: 'inspect' }] },
};
const dispatch = (args: JsonObject = delegated): Reply => ({
  tool: 'run_subagent',
  arguments: args,
});
const final: Reply = { result: { ok: true } };

async function fixture(
  replies: Reply[],
  options: {
    modelCalls?: number;
    scopeCalls?: number;
    executionTimeoutMs?: number;
    execute?(context: RuntimeContext): Promise<JsonObject>;
  } = {},
) {
  const requests: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(object(JSON.parse(body)));
    const reply = replies[requests.length - 1];
    if (reply === null) return;
    if (reply === undefined || 'error' in reply) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: reply?.error ?? 'Unexpected call' },
        }),
      );
      return;
    }
    const tool = 'tool' in reply;
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `tool-${requests.length}`,
              type: 'function',
              function: {
                name: reply.tool,
                arguments: JSON.stringify(reply.arguments),
              },
            },
          ],
        }
      : { role: 'assistant', content: JSON.stringify(reply.result) };
    const chunk = (delta: object, finish_reason: string | null): string =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
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
  const previous = process.env.RSI_SUBAGENT_TEST_KEY;
  process.env.RSI_SUBAGENT_TEST_KEY = 'local-fixture-key';
  const controller = new AbortController();
  const parent: JsonObject = {
    agentRef: 'agent',
    goal: 'Parent-only goal',
    prompt: 'Parent-only instructions',
    input: { privateToParent: 'not automatically inherited' },
    files: { source: 'original source', other: 'other component evidence' },
    maxModelCalls: 8,
    outputSchema: { type: 'object' },
  };
  let manager: Awaited<ReturnType<typeof managerFixture>>;
  try {
    manager = await managerFixture(
      async (context) => {
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const scoped = context.extend({
          signal,
          scope: {
            id: 'reflection-scope',
            signal,
            limits: {
              modelCalls: options.scopeCalls ?? 20,
              evidenceBytes: 1024 * 1024,
            },
          },
        });
        return options.execute
          ? options.execute(scoped)
          : scoped.invokeAgent(parent);
      },
      {
        budget: { modelCalls: options.modelCalls ?? 20 },
        plugins: [piDefinition, reflectionDefinition],
        bindings: {
          agent: {
            plugin: 'agent.pi',
            config: {
              model: 'fixture',
              base_url: `http://127.0.0.1:${address.port}/v1`,
              api_key: '${RSI_SUBAGENT_TEST_KEY}',
              timeoutMs: 3000,
              ...(options.executionTimeoutMs === undefined
                ? {}
                : { executionTimeoutMs: options.executionTimeoutMs }),
            },
          },
          reflector: {
            plugin: 'reflection.agent',
            config: {
              agentRef: 'agent',
              prompt: join(
                process.cwd(),
                'src/plugins/reflection-agent/prompt.md',
              ),
            },
          },
        },
      },
    );
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (previous === undefined) delete process.env.RSI_SUBAGENT_TEST_KEY;
    else process.env.RSI_SUBAGENT_TEST_KEY = previous;
    throw error;
  }
  return {
    ...manager,
    requests,
    controller,
    async close() {
      controller.abort();
      try {
        await manager.dispose();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        if (previous === undefined) delete process.env.RSI_SUBAGENT_TEST_KEY;
        else process.env.RSI_SUBAGENT_TEST_KEY = previous;
      }
    },
  };
}

function userInput(request: JsonObject): JsonObject {
  assert.ok(Array.isArray(request.messages));
  const message = request.messages
    .map((v) => object(v))
    .find((v) => v.role === 'user');
  assert.ok(message);
  const content = Array.isArray(message.content)
    ? message.content.map((part) => string(object(part).text)).join('')
    : string(message.content);
  return object(JSON.parse(content));
}

test('main agent chooses child input and files, receives its result, and records nested calls', async (t) => {
  const task = {
    ...delegated,
    filePaths: ['other'],
    files: { prepared: 'main-agent supplied text' },
    outputSchema: { type: 'object', required: ['finding'] },
  };
  const f = await fixture([
    dispatch(task),
    { tool: 'read_file', arguments: { path: 'prepared' } },
    { result: { finding: 'useful evidence' } },
    final,
  ]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(f.requests.length, 4);
  const child = userInput(f.requests[1]!);
  assert.deepEqual(child.input, delegated.input);
  assert.deepEqual(child.files, ['other', 'prepared']);
  assert.doesNotMatch(
    JSON.stringify(f.requests[1]),
    /Parent-only|privateToParent/,
  );
  assert.match(JSON.stringify(f.requests[2]), /main-agent supplied text/);
  assert.match(JSON.stringify(f.requests[3]), /useful evidence/);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  const parent = calls.find((c) => object(c.input).goal === 'Parent-only goal');
  const nested = calls.find((c) => c.parentCallId === parent?.callId);
  assert.ok(parent && nested);
  assert.equal(nested.status, 'succeeded');
  assert.deepEqual(object(nested.input).files, {
    other: 'other component evidence',
    prepared: 'main-agent supplied text',
  });
  const budget = await f.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 4);
  assert.equal(object(object(budget.scopes)['reflection-scope']).modelCalls, 4);
  assert.match(
    await readFile(
      join(
        f.manager.directory,
        'experiments/test/calls',
        string(nested.callId),
        'diagnostics.jsonl',
      ),
      'utf8',
    ),
    /tool_execution_end/,
  );
});

test('delegation can share all files or only main-agent text without an imposed input packet', async (t) => {
  const f = await fixture([
    dispatch(),
    final,
    dispatch({
      ...delegated,
      filePaths: [],
      input: 'free-form context',
      files: { note: 'standalone' },
    }),
    final,
    final,
  ]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.deepEqual(userInput(f.requests[1]!).files, ['source', 'other']);
  assert.deepEqual(userInput(f.requests[3]!).files, ['note']);
  assert.equal(userInput(f.requests[3]!).input, 'free-form context');
});

test('identical delegated requests reuse the child receipt instead of repeating execution', async (t) => {
  const f = await fixture([dispatch(), final, dispatch(), final]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  const agents = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(agents.length, 2);
  assert.equal(f.requests.length, 4);
});

test('delegation is available by default without requiring the agent to use it', async (t) => {
  const f = await fixture([final]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(f.requests.length, 1);
  assert.match(JSON.stringify(f.requests[0]!.tools), /run_subagent/);
  assert.equal(
    (await f.manager.facts.list('calls')).filter((c) => c.bindingId === 'agent')
      .length,
    1,
  );
});

test('children can delegate recursively with isolated context and linked receipts', async (t) => {
  const task = { ...delegated, filePaths: ['other'] };
  const f = await fixture([
    dispatch(task),
    dispatch(task),
    { result: { finding: 'nested evidence' } },
    { result: { summary: 'consolidated nested evidence' } },
    final,
  ]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(f.requests.length, 5);
  for (const request of f.requests)
    assert.match(JSON.stringify(request.tools), /run_subagent/);
  const grandchild = userInput(f.requests[2]!);
  assert.deepEqual(grandchild.input, delegated.input);
  assert.deepEqual(grandchild.files, ['other']);
  assert.doesNotMatch(
    JSON.stringify(f.requests[2]),
    /Parent-only|privateToParent/,
  );
  assert.match(JSON.stringify(f.requests[3]), /nested evidence/);
  assert.match(JSON.stringify(f.requests[4]), /consolidated nested evidence/);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 3);
  const parent = calls.find((c) => object(c.input).goal === 'Parent-only goal');
  const child = calls.find((c) => c.parentCallId === parent?.callId);
  const nested = calls.find((c) => c.parentCallId === child?.callId);
  assert.ok(parent && child && nested);
  assert.ok(calls.every((c) => c.status === 'succeeded'));
  assert.deepEqual(object(nested.input).files, {
    other: 'other component evidence',
  });
  const budget = await f.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 5);
  assert.equal(object(object(budget.scopes)['reflection-scope']).modelCalls, 5);
});

test('delegation rejects unknown inherited file references before starting a child', async (t) => {
  const f = await fixture([
    dispatch({ ...delegated, filePaths: ['C:/private.txt'] }),
    final,
  ]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.match(JSON.stringify(f.requests[1]), /outside supplied snapshot/);
  assert.equal(
    (await f.manager.facts.list('calls')).filter((c) => c.bindingId === 'agent')
      .length,
    1,
  );
});

test('child failures remain visible and repeated requests do not replay failed calls', async (t) => {
  const f = await fixture([
    dispatch(),
    { error: 'Child unavailable' },
    dispatch(),
    final,
  ]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.match(JSON.stringify(f.requests[2]), /Child unavailable/);
  assert.match(JSON.stringify(f.requests[3]), /Child unavailable/);
  const child = (await f.manager.facts.list('calls')).find(
    (c) => object(c.input).goal === delegated.goal,
  );
  assert.equal(child?.status, 'failed');
  assert.equal(child?.output, undefined);
  assert.equal(f.requests.length, 4);
});

test('recursive delegation exhausts one shared scope or experiment budget', async () => {
  for (const limits of [{ scopeCalls: 3 }, { modelCalls: 3 }]) {
    const f = await fixture(
      [dispatch(), dispatch(), final, final, final],
      limits,
    );
    try {
      await assert.rejects(f.run(), /budget exceeded|Budget exceeded/);
      assert.equal(f.requests.length, 3);
      assert.equal(
        (await f.manager.facts.read('budgets', 'test')).modelCalls,
        3,
      );
    } finally {
      await f.close();
    }
  }
});

test('scope exhaustion inside a grandchild stops its continuation and all ancestors', async (t) => {
  const f = await fixture(
    [
      dispatch(),
      dispatch(),
      { tool: 'read_file', arguments: { path: 'source' } },
      final,
    ],
    { scopeCalls: 3 },
  );
  t.after(() => f.close());
  await assert.rejects(f.run(), /Reflection modelCalls budget exceeded/);
  assert.equal(f.requests.length, 3);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.status === 'failed'));
});

test('cancellation stops an active grandchild and prevents all ancestor continuations', async (t) => {
  const f = await fixture([dispatch(), dispatch(), null, final, final]);
  t.after(() => f.close());
  const pending = assert.rejects(f.run(), /Cancel delegated reflection/);
  const deadline = Date.now() + 5000;
  while (f.requests.length < 3 && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(f.requests.length, 3);
  f.controller.abort(new Error('Cancel delegated reflection'));
  await pending;
  assert.equal(f.requests.length, 3);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.status === 'cancelled'));
});

test('parent execution timeout cancels active descendants before their own deadlines', async (t) => {
  const f = await fixture([dispatch(), dispatch(), null, final, final], {
    executionTimeoutMs: 2000,
  });
  t.after(() => f.close());
  await assert.rejects(f.run(), /Agent execution timed out/);
  assert.equal(f.requests.length, 3);
  assert.equal(f.controller.signal.aborted, false);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 3);
  const parent = calls.find((c) => object(c.input).goal === 'Parent-only goal');
  assert.equal(parent?.status, 'failed');
  assert.ok(
    calls
      .filter((c) => c.callId !== parent?.callId)
      .every((c) => c.status === 'cancelled'),
  );
});

test('Reflection retains its complete input and consolidates actual delegated edits', async (t) => {
  const path = 'bindings/proposer/resources/guidance/rules.md';
  const edit = {
    edits: [{ path, content: 'Inspect the source before editing.' }],
    reason: 'Delegated finding',
  };
  const f = await fixture([dispatch(), { result: edit }, { result: edit }], {
    execute: async (context) => {
      const resourceRef = await context.artifacts.putJson({
        kind: 'file-tree',
        files: [
          {
            path,
            mode: 0o644,
            base64: Buffer.from('Original').toString('base64'),
          },
        ],
      });
      await context.facts.write('evidence-views', 'observations', {
        experimentId: context.experimentId,
        view: 'reflection-observations/v1',
        evidenceView: 'execution',
        files: {
          'context/one.txt': 'first component',
          'context/two.txt': 'second component',
        },
        index: { calls: ['one', 'two'] },
      });
      return object(
        await context.invoke('reflector', {
          parentRevisionRefs: { proposer: 'initial' },
          resourceRef,
          goal: 'Reflect on supplied components',
          evidenceRefs: ['observations'],
          editConstraints: { allowedPaths: [path] },
        }),
      );
    },
  });
  t.after(() => f.close());
  const result = await f.run();
  assert.equal(result.status, 'succeeded');
  const output = object(result.output);
  assert.equal(output.status, 'proposed');
  const files = object(
    object(
      (await f.manager.facts.list('calls')).find(
        (c) =>
          c.bindingId === 'agent' &&
          object(c.input).goal === 'Reflect on supplied components',
      )!.input,
    ).files,
  );
  assert.equal(files[path], 'Original');
  assert.equal(files['context/one.txt'], 'first component');
  assert.equal(files['context/two.txt'], 'second component');
  assert.ok(files['context/reflection/index.json']);
  const updated = object(
    await f.manager.artifacts.readJson(
      string(object(output.proposal).resourceRef),
    ),
  );
  assert.ok(Array.isArray(updated.files));
  const revised = updated.files
    .map((v) => object(v))
    .find((v) => v.path === path);
  assert.ok(revised);
  assert.equal(
    Buffer.from(string(revised.base64), 'base64').toString(),
    edit.edits[0]!.content,
  );
});
