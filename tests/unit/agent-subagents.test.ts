import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject, RuntimeContext } from '../../src/contracts/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { object, string } from '../../src/shared/json.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
import { managerFixture } from '../helpers/manager-fixture.js';

type Reply =
  | { result: JsonObject }
  | { tool: string; arguments: JsonObject }
  | { error: string }
  | null;

const delegatedTask = 'Investigate the chosen question';
const dispatch = (agent = 'scout'): Reply => ({
  tool: 'subagent',
  arguments: { agent, task: delegatedTask },
});
const finding: Reply = { result: { findings: 'Useful evidence' } };
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
        if (options.execute) return options.execute(scoped);
        const prompt = join(context.directory, 'scout.md');
        await writeFile(prompt, 'SPECIALIST_INSTRUCTIONS');
        const cwd = await prepareAgentProject(
          scoped,
          'SHARED_INSTRUCTIONS',
          { 'context/source.txt': 'Shared evidence' },
          [],
          [{ name: 'scout', description: 'Inspect the project', prompt }],
        );
        return scoped.invokeAgent('agent', {
          cwd,
          goal: 'Parent-only goal',
          outputSchema: { type: 'object' },
        });
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

test('a configured Pi specialist shares the project cwd and Manager budget', async (t) => {
  const f = await fixture(
    [
      {
        tool: 'subagent',
        arguments: { agent: 'scout', task: 'Inspect the shared measurement' },
      },
      { tool: 'read', arguments: { path: 'context/measurements.json' } },
      { result: { findings: 'Shared evidence inspected' } },
      final,
    ],
    {
      scopeCalls: 4,
      async execute(context) {
        const prompt = join(context.directory, 'scout.md');
        await writeFile(prompt, 'SPECIALIST_INSTRUCTIONS');
        const cwd = await prepareAgentProject(
          context,
          'SHARED_INSTRUCTIONS',
          { 'context/measurements.json': 'SHARED_MEASUREMENT' },
          [],
          [{ name: 'scout', description: 'Inspect measurements', prompt }],
        );
        const request = {
          cwd,
          goal: 'Coordinate',
          outputSchema: { type: 'object' },
        };
        const result = await context.invokeAgent('agent', request);
        await writeFile(
          join(cwd, 'scratch', 'temporary.txt'),
          'Temporary work',
        );
        assert.deepEqual(await context.invokeAgent('agent', request), result);
        return result;
      },
    },
  );
  t.after(() => f.close());
  const result = await f.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(f.requests.length, 4);
  assert.match(JSON.stringify(f.requests[0]), /SHARED_INSTRUCTIONS/);
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /SPECIALIST_INSTRUCTIONS/);
  assert.match(JSON.stringify(f.requests[1]), /SPECIALIST_INSTRUCTIONS/);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /Coordinate/);
  assert.doesNotMatch(
    JSON.stringify(f.requests[1]!.tools),
    /"name":"subagent"/,
  );
  assert.match(JSON.stringify(f.requests[2]), /SHARED_MEASUREMENT/);
  assert.match(JSON.stringify(f.requests[3]), /Shared evidence inspected/);
  const calls = (await f.manager.facts.list('calls')).filter(
    (call) => call.bindingId === 'agent',
  );
  assert.equal(calls.length, 2);
  const child = calls.find((call) => object(call.input).role === 'scout');
  assert.ok(child);
  const parent = calls.find((call) => call.callId === child.parentCallId);
  assert.ok(parent);
  assert.equal(object(child.input).cwd, object(parent.input).cwd);
  const budget = await f.manager.facts.read('budgets', 'test');
  assert.equal(budget.modelCalls, 4);
  assert.equal(object(object(budget.scopes)['reflection-scope']).modelCalls, 4);
});

test('identical delegated requests reuse the child receipt instead of repeating execution', async (t) => {
  const f = await fixture([dispatch(), finding, dispatch(), final]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  const agents = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(agents.length, 2);
  assert.equal(f.requests.length, 4);
});

test('delegation rejects an unknown role before starting a child', async (t) => {
  const f = await fixture([dispatch('unknown'), final]);
  t.after(() => f.close());
  assert.equal((await f.run()).status, 'succeeded');
  assert.match(JSON.stringify(f.requests[1]), /agent: expected one of/);
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
    (c) => object(c.input).goal === delegatedTask,
  );
  assert.equal(child?.status, 'failed');
  assert.equal(child?.output, undefined);
  assert.equal(f.requests.length, 4);
});

test('a specialist and its parent share the scope and experiment budgets', async () => {
  for (const limits of [{ scopeCalls: 2 }, { modelCalls: 2 }]) {
    const f = await fixture(
      [dispatch(), { tool: 'read', arguments: { path: 'context/source.txt' } }],
      limits,
    );
    try {
      await assert.rejects(f.run(), /budget exceeded/i);
      assert.equal(f.requests.length, 2);
      assert.equal(
        (await f.manager.facts.read('budgets', 'test')).modelCalls,
        2,
      );
      const calls = (await f.manager.facts.list('calls')).filter(
        (call) => call.bindingId === 'agent',
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((call) => call.status),
        'scopeCalls' in limits
          ? ['failed', 'failed']
          : ['cancelled', 'cancelled'],
      );
    } finally {
      await f.close();
    }
  }
});

test('cancellation stops the active specialist and parent', async (t) => {
  const f = await fixture([dispatch(), null, final]);
  t.after(() => f.close());
  const pending = assert.rejects(f.run(), /Cancel delegated reflection/);
  const deadline = Date.now() + 5000;
  while (f.requests.length < 2 && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(f.requests.length, 2);
  f.controller.abort(new Error('Cancel delegated reflection'));
  await pending;
  assert.equal(f.requests.length, 2);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.status === 'cancelled'));
});

test('parent execution timeout cancels the active specialist before its own deadline', async (t) => {
  const f = await fixture([dispatch(), null, final], {
    executionTimeoutMs: 2000,
  });
  t.after(() => f.close());
  await assert.rejects(f.run(), /Agent execution timed out/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.controller.signal.aborted, false);
  const calls = (await f.manager.facts.list('calls')).filter(
    (c) => c.bindingId === 'agent',
  );
  assert.equal(calls.length, 2);
  const parent = calls.find((c) => object(c.input).goal === 'Parent-only goal');
  assert.equal(parent?.status, 'failed');
  assert.ok(
    calls
      .filter((c) => c.callId !== parent?.callId)
      .every((c) => c.status === 'cancelled'),
  );
});

test('Reflection exposes its complete input in the project and applies the final edits', async (t) => {
  const path = 'bindings/proposer/resources/guidance/rules.md';
  const edit = {
    edits: [{ path, content: 'Inspect the source before editing.' }],
    reason: 'Delegated finding',
  };
  const f = await fixture([{ result: edit }], {
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
  const call = (await f.manager.facts.list('calls')).find(
    (call) =>
      call.bindingId === 'agent' &&
      object(call.input).goal === 'Reflect on supplied components',
  );
  assert.ok(call);
  const cwd = string(object(call.input).cwd);
  assert.equal(
    await readFile(join(cwd, 'candidate', path), 'utf8'),
    'Original',
  );
  assert.equal(
    await readFile(join(cwd, 'context/one.txt'), 'utf8'),
    'first component',
  );
  assert.equal(
    await readFile(join(cwd, 'context/two.txt'), 'utf8'),
    'second component',
  );
  assert.ok(await readFile(join(cwd, 'context/reflection/index.json'), 'utf8'));
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
