import type { JsonValue, JsonObject } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { object } from '../../src/shared/json.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('Codex drives app-server, records commentary and tools, and validates the terminal answer', async (t) => {
  const sent: JsonValue[] = [];
  const f = await agentFixture(async (spec, consume) => {
    assert(spec.interactive);
    const send = (message: JsonValue) => sent.push(message);
    for (const message of [
      { id: 1, result: {} },
      { id: 4, result: { config: { windows: {} }, origins: {} } },
      { id: 2, result: { thread: { id: 'thread1' }, model: 'test' } },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'comment',
            type: 'agentMessage',
            phase: 'commentary',
            text: 'Reading',
          },
        },
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            command: 'cat candidate/input.txt',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'tool1',
            type: 'commandExecution',
            status: 'completed',
            aggregatedOutput: 'original',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: { id: 'answer', type: 'agentMessage', text: '{"answer":"ok"}' },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'child',
          turnId: 'child-turn',
          item: {
            id: 'child-message',
            type: 'agentMessage',
            text: 'Child output',
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread1',
          item: {
            id: 'delegate',
            type: 'collabToolCall',
            tool: 'spawnAgent',
            senderThreadId: 'thread1',
            receiverThreadIds: ['child'],
            status: 'completed',
          },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'child',
          turn: { id: 'child-turn', status: 'completed' },
        },
      },
      ...['item/started', 'item/completed'].map((method) => ({
        method,
        params: {
          threadId: 'thread1',
          item: {
            id: 'lifecycle',
            type: 'subAgentActivity',
            kind: 'started',
            agentThreadId: 'child',
            agentPath: '/root/baseline',
          },
        },
      })),
      ...['item/started', 'item/completed'].map((method) => ({
        method,
        params: {
          threadId: 'thread1',
          item: {
            id: 'wait-1',
            type: 'collabAgentToolCall',
            tool: 'wait',
            senderThreadId: 'thread1',
            receiverThreadIds: [],
            startedAtMs: 1000,
            ...(method === 'item/completed'
              ? { completedAtMs: 1300, status: 'completed' }
              : { status: 'inProgress' }),
          },
        },
      })),
      {
        method: 'thread/started',
        params: {
          thread: {
            id: 'declared-child',
            parentThreadId: 'thread1',
            agentRole: 'reviewer',
          },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread1',
          turn: { id: 'main-turn', status: 'completed' },
        },
      },
    ])
      await consume(JSON.stringify(message), send);
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  assert.equal(sent.length, process.platform === 'win32' ? 4 : 3);
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  const submitted = object(object(sent.at(-1)).params);
  assert.deepEqual(submitted.input, [
    { type: 'text', text: f.request.message },
  ]);
  assert.deepEqual(submitted.outputSchema, f.request.outputSchema);
  assert.deepEqual(records.submitted?.event, {
    type: 'task.submitted',
    text: Array.isArray(submitted.input)
      ? object(submitted.input[0]).text
      : undefined,
    outputSchema: submitted.outputSchema,
  });
  assert.equal(records.gaps, 0);
  assert.deepEqual(
    records.items
      .filter((r) => r.type === 'subagent.activity')
      .map((r) => [r.runId, r.event]),
    [
      [
        'main',
        {
          type: 'subagent.activity',
          activity: 'started',
          childRunId: 'child',
          agentPath: '/root/baseline',
        },
      ],
    ],
  );
  const waits = records.items.filter(
    (r) =>
      (r.event.type === 'tool.started' || r.event.type === 'tool.completed') &&
      r.event.toolCallId === 'wait-1',
  );
  assert.deepEqual(
    waits.map((r) => [r.runId, r.type]),
    [
      ['main', 'tool.started'],
      ['main', 'tool.completed'],
    ],
  );
  assert.equal(
    waits[1].event.type === 'tool.completed' && waits[1].event.durationMs,
    300,
  );
  const finishes = records.items.filter((r) => r.type === 'run.finished');
  assert.deepEqual(
    finishes.map(({ runId, native, event }) => [runId, native?.turnId, event]),
    [
      [
        'child',
        'child-turn',
        {
          type: 'run.finished',
          status: 'completed',
          nativeStatus: 'completed',
        },
      ],
      [
        'main',
        'main-turn',
        {
          type: 'run.finished',
          status: 'completed',
          nativeStatus: 'completed',
        },
      ],
    ],
  );
  assert.deepEqual(
    records.items.find((r) => r.runId === 'child' && r.type === 'run.linked')
      ?.event,
    { type: 'run.linked', parentRunId: 'main' },
  );
  assert.deepEqual(
    records.items.find(
      (r) => r.runId === 'declared-child' && r.type === 'run.started',
    )?.event,
    {
      type: 'run.started',
      backend: 'agent.codex',
      parentRunId: 'main',
      role: 'reviewer',
    },
  );
  assert(
    records.items.some(
      (r) =>
        r.event?.type === 'message.completed' && r.event.phase === 'commentary',
    ),
  );
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
});

test('native agents reject an unenforceable modelCalls budget before launch', async (t) => {
  const f = await agentFixture(async () => {
    assert.fail('must not launch');
  });
  t.after(() => f.close());
  const agent = await createAgentCodex(
    { executable: process.execPath },
    f.context,
  );
  await assert.rejects(
    f.execute(
      agent,
      f.request,
      f.context.extend({
        scope: {
          id: 'test',
          signal: f.context.signal,
          limits: { modelCalls: 1 },
        },
      }),
    ),
    /cannot enforce/,
  );
});

for (const model of [undefined, 'explicit-model']) {
  test(`Codex forwards CLI options and schema with model ${model ?? 'default'}`, async (t) => {
    const sent: Array<JsonObject> = [];
    const f = await agentFixture(async (spec, consume) => {
      const send = (message: JsonValue) => {
        sent.push(JSON.parse(JSON.stringify(message)));
      };
      assert(spec.args.includes('approval_policy="never"'));
      assert.deepEqual(
        spec.args.slice(-(model ? 4 : 1)),
        model
          ? [
              'app-server',
              `--config=model="${model}"`,
              '-c',
              'model_reasoning_effort="high"',
            ]
          : ['app-server'],
      );
      await consume(JSON.stringify({ id: 1, result: {} }), send);
      await consume(
        JSON.stringify({
          id: 4,
          result: { config: { windows: {} }, origins: {} },
        }),
        send,
      );
      await consume(
        JSON.stringify({ id: 2, result: { thread: { id: 't' } } }),
        send,
      );
      await consume(
        JSON.stringify({
          method: 'item/completed',
          params: {
            threadId: 't',
            item: { type: 'agentMessage', text: '{"answer":"ok"}' },
          },
        }),
        send,
      );
      await consume(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 't', turn: { status: 'completed' } },
        }),
        send,
      );
    });
    t.after(() => f.close());
    const agent = await createAgentCodex(
      {
        executable: process.execPath,
        ...(model
          ? {
              options: [
                `--config=model="${model}"`,
                '-c',
                'model_reasoning_effort="high"',
              ],
            }
          : {}),
      },
      f.context,
    );
    assert.deepEqual(await f.execute(agent), { answer: 'ok' });
    assert.deepEqual(
      sent.find((message) => message.method === 'thread/start'),
      {
        id: 2,
        method: 'thread/start',
        params: {
          cwd: f.directory,
          ephemeral: true,
          ...(process.platform === 'win32'
            ? { sandbox: 'danger-full-access' }
            : {}),
        },
      },
    );
    const turn = sent.find((message) => message.method === 'turn/start')!
      .params as JsonObject;
    assert.deepEqual(turn.outputSchema, f.request.outputSchema);
    assert.equal('baseInstructions' in turn, false);
    assert.equal('approvalPolicy' in turn, false);
  });
}

for (const [message, pattern] of [
  [
    { id: 1, error: { code: -32000, message: 'Native transport failed' } },
    /Native transport failed.*-32000/,
  ],
  [
    { id: 9, method: 'item/commandExecution/requestApproval', params: {} },
    /requires interactive input or approval/,
  ],
  [
    {
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: { code: 'context_window_exceeded', message: 'Context full' },
        },
      },
    },
    /Context full.*context_window_exceeded/,
  ],
] as const) {
  test(`Codex preserves native failure: ${pattern.source}`, async (t) => {
    let launches = 0;
    const f = await agentFixture(async (_spec, consume) => {
      launches++;
      if ('method' in message)
        await consume(
          JSON.stringify({ id: 2, result: { thread: { id: 't' } } }),
          () => {},
        );
      await consume(JSON.stringify(message), () => {});
    });
    t.after(() => f.close());
    const agent = await createAgentCodex(
      { executable: process.execPath },
      f.context,
    );
    await assert.rejects(f.execute(agent), pattern);
    assert.equal(launches, 'method' in message ? 1 : 3);
  });
}

for (const sandbox of ['elevated', 'unelevated'] as const) {
  test(
    `Codex retains the native Windows ${sandbox} sandbox in standalone execution`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const sent: Array<JsonObject> = [];
      const f = await agentFixture(async (spec, consume) => {
        assert(
          spec.args.includes('sandbox_workspace_write.network_access=true'),
        );
        assert.equal(
          Object.keys(spec.env ?? {}).some(
            (name) => name.toUpperCase() === 'CODEX_WINDOWS_REGISTERED_CORE',
          ),
          false,
        );
        const send = (message: JsonValue) =>
          sent.push(JSON.parse(JSON.stringify(message)));
        for (const message of [
          { id: 1, result: {} },
          {
            id: 4,
            result: {
              config: { windows: { sandbox } },
              origins: { 'windows.sandbox': {} },
            },
          },
          { id: 2, result: { thread: { id: 't' } } },
          {
            method: 'item/completed',
            params: {
              threadId: 't',
              item: { type: 'agentMessage', text: '{"answer":"ok"}' },
            },
          },
          {
            method: 'turn/completed',
            params: { threadId: 't', turn: { status: 'completed' } },
          },
        ])
          await consume(JSON.stringify(message), send);
      });
      t.after(() => f.close());
      const previous = process.env.CODEX_WINDOWS_REGISTERED_CORE;
      process.env.CODEX_WINDOWS_REGISTERED_CORE = '1';
      t.after(() => {
        if (previous === undefined)
          delete process.env.CODEX_WINDOWS_REGISTERED_CORE;
        else process.env.CODEX_WINDOWS_REGISTERED_CORE = previous;
      });
      const agent = await createAgentCodex(
        { executable: process.execPath },
        f.context,
      );
      assert.deepEqual(await f.execute(agent), { answer: 'ok' });
      assert.equal(
        (
          sent.find((message) => message.method === 'thread/start')!
            .params as JsonObject
        ).sandbox,
        'workspace-write',
      );
      assert.equal(process.env.CODEX_WINDOWS_REGISTERED_CORE, '1');
    },
  );
}

for (const phase of ['startup', 'submitted'] as const) {
  test(`Codex retries only before turn submission: ${phase}`, async (t) => {
    let launches = 0;
    let turns = 0;
    const f = await agentFixture(async (_spec, consume) => {
      launches++;
      if (phase === 'startup' && launches === 1)
        throw new Error('startup failed');
      await consume(
        JSON.stringify({ id: 2, result: { thread: { id: 't' } } }),
        () => {
          turns++;
        },
      );
      if (phase === 'submitted') throw new Error('turn interrupted');
      await consume(
        JSON.stringify({
          method: 'item/completed',
          params: {
            threadId: 't',
            item: { id: 'm', type: 'agentMessage', text: '{"answer":"ok"}' },
          },
        }),
        () => {},
      );
      await consume(
        JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 't', turn: { status: 'completed' } },
        }),
        () => {},
      );
    });
    t.after(() => f.close());
    const agent = await createAgentCodex(
      { executable: process.execPath },
      f.context,
    );
    if (phase === 'submitted')
      await assert.rejects(f.execute(agent), /turn interrupted/);
    else assert.deepEqual(await f.execute(agent), { answer: 'ok' });
    assert.equal(launches, phase === 'startup' ? 2 : 1);
    assert.equal(turns, 1);
  });
}
