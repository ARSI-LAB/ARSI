import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { resolveModelConfig } from '../../src/plugins/agent-pi/service.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import type { AgentPiConfig } from '../../src/plugins/agent-pi/schema.js';

import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { validate } from '../../src/shared/schema.js';
import { agentTaskMessage } from '../fixtures/agent-execution.js';

interface Reply {
  contextTokens?: number;
  status?: number;
  content?: string;
  read?: boolean;
  tool?: { name: string; arguments: string };
  delayMs?: number;
  stall?: boolean;
}

function respond(response: ServerResponse, reply: Reply): void {
  if (reply.status) {
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { message: reply.content ?? 'Fixture error' } }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: object, finish_reason: string | null): string =>
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(
    chunk(
      reply.read || reply.tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read',
                type: 'function',
                function: reply.tool ?? {
                  name: 'read',
                  arguments: '{"path":"sample"}',
                },
              },
            ],
          }
        : { role: 'assistant', content: reply.content ?? '{"ok":true}' },
      null,
    ) +
      chunk({}, reply.read || reply.tool ? 'tool_calls' : 'stop') +
      (reply.contextTokens === undefined
        ? ''
        : `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage: { prompt_tokens: reply.contextTokens, completion_tokens: 1, total_tokens: reply.contextTokens + 1 } })}\n\n`) +
      'data: [DONE]\n\n',
  );
}

async function modelFixture(
  replies: Reply[],
  settings: AgentPiConfig = {},
  chargeLimit = Infinity,
) {
  const requests: JsonObject[] = [];
  const charges: number[] = [];
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const responseCloses: Promise<void>[] = [];
  let disconnected = 0;
  let chargeAttempts = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    responseCloses.push(
      new Promise<void>((resolve) => {
        response.once('close', () => {
          disconnected++;
          resolve();
        });
      }),
    );
    if (reply.stall) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) respond(response, reply);
    }, reply.delayMs ?? 0);
    timers.add(timer);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture address');
  const directory = await mkdtemp(join(tmpdir(), 'rsi-agent-pi-test-'));
  const cwd = join(directory, 'workspace');
  await mkdir(cwd);
  await writeFile(
    join(cwd, 'AGENTS.md'),
    'Read the supplied evidence if needed, then return only JSON.',
  );
  await writeFile(join(cwd, 'sample'), 'authorized evidence');
  const previous = process.env.RSI_PI_TEST_KEY;
  process.env.RSI_PI_TEST_KEY = 'fixture-private-key';
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected service');
  };
  const services: RuntimeContext = new RuntimeContext().extend({
    rootDirectory: directory,
    dataDirectory: directory,
    artifacts: {
      putJson: unused,
      readJson: unused,
      capture: unused,
      materialize: unused,
    },
    facts: { read: unused, write: unused, list: unused },
    workspaces: { create: unused, read: unused, release: unused },
    readCandidate: unused,
    recordCandidate: unused,
    recordMeasurement: unused,
    readMeasurement: unused,
    application: unused,
    applicationMetadata: unused,
    invokeAgent: unused,
    readEvidence: unused,
    invoke: unused,
    withInstance: unused,
    charge: async (metric, amount) => {
      assert.equal(metric, 'modelCalls');
      chargeAttempts++;
      if (charges.length >= chargeLimit) throw new Error('Budget rejected 503');
      charges.push(amount);
    },
  });
  const registry = new Registry();
  registry.registerOperation(piDefinition);
  const operation = await registry.createManagedOperation(
    piDefinition.id,
    {
      model: 'fixture',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '${RSI_PI_TEST_KEY}',
      timeoutMs: 4000,
      ...settings,
    },
    services,
  );
  const context: RuntimeContext = new RuntimeContext().extend({
    experimentId: 'test',
    callId: 'test',
    bindingId: 'agent',
    idempotencyKey: 'test',
    directory,
    signal: controller.signal,
    cleanup: new AbortController().signal,
  });
  let serial = 0;
  const callContext = () =>
    context
      .extend(services)
      .extend({ directory: join(directory, `call-${serial++}`) });
  return {
    requests,
    directory,
    execute: (cwd: string, role?: string) =>
      operation.execute(
        {
          cwd,
          message: agentTaskMessage,
          outputSchema: { type: 'object' },
          ...(role === undefined ? {} : { role }),
        },
        callContext(),
      ),
    charges,
    controller,
    services,
    disconnected: () => disconnected,
    async waitForResponseClose(requestIndex: number): Promise<void> {
      const closed = responseCloses[requestIndex];
      if (!closed)
        throw new Error(`Fixture request ${requestIndex} was not received`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`Fixture response ${requestIndex} did not close`),
                ),
              4000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    chargeAttempts: () => chargeAttempts,
    definition: registry.get(piDefinition.id),
    run: () =>
      operation.execute(
        {
          cwd,
          message: agentTaskMessage,
          outputSchema: {
            type: 'object',
            properties: { ok: { const: true } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
        callContext(),
      ),
    async close() {
      controller.abort();
      await operation.dispose();
      await registry.dispose();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RSI_PI_TEST_KEY;
      else process.env.RSI_PI_TEST_KEY = previous;
    },
  };
}

test('Agent uses SDK model fields and resolves environment references without persisting credentials', () => {
  const env = {
    MODEL_NAME: 'test-model',
    MODEL_ENDPOINT: 'https://model.example/v1',
    MODEL_API_KEY: 'test-credential',
    MODEL_HOST: 'model.example',
  };
  const config = {};
  const resolved = (
    raw: AgentPiConfig,
    environment: Readonly<Record<string, string | undefined>> = env,
  ) => resolveModelConfig(raw, environment);
  assert.deepEqual(resolved(config), {
    model: 'test-model',
    base_url: 'https://model.example/v1',
    api_key: 'test-credential',
  });
  assert.deepEqual(config, {});
  assert.equal(
    resolved({ model: 'explicit-model', base_url: 'https://${MODEL_HOST}/v1' })
      .model,
    'explicit-model',
  );
  assert.equal(
    resolved({ base_url: 'https://${MODEL_HOST}/v1' }).base_url,
    'https://model.example/v1',
  );
  assert.throws(() => resolved({}, {}), /MODEL_NAME/);
  assert.throws(
    () => resolved({}, { ...env, MODEL_API_KEY: '  ' }),
    /api_key.*empty/,
  );
});

test('Pi uses the workspace instructions, default tools, and on-demand skill contents', async () => {
  const fixture = await modelFixture([
    {
      tool: {
        name: 'read',
        arguments: '{"path":".agents/skills/probe/SKILL.md"}',
      },
    },
    { content: '{"ok":true}' },
  ]);
  try {
    const project = join(fixture.directory, 'project');
    const skill = join(project, '.agents/skills/probe');
    await mkdir(skill, { recursive: true });
    await writeFile(join(project, 'AGENTS.md'), 'WORKSPACE_INSTRUCTIONS');
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: probe\ndescription: WORKSPACE_SKILL_DESCRIPTION\n---\nWORKSPACE_SKILL_BODY',
    );
    assert.deepEqual(await fixture.execute(project), { ok: true });
    const records = await readAgentRecords(
      join(fixture.directory, 'call-0'),
      0,
      100,
      true,
    );
    assert.deepEqual(records.submitted?.event, {
      type: 'task.submitted',
      text: agentTaskMessage,
      outputSchema: { type: 'object' },
    });
    assert.deepEqual(records.items.at(-1)?.event, {
      type: 'run.finished',
      status: 'completed',
      nativeStatus: 'stop',
    });
    const final = records.items.find(
      (item) => item.sequence === records.finalResponses[0]?.sequence,
    )?.event;
    assert.equal(final?.type, 'message.completed');
    assert.equal(final.text, '{"ok":true}');
    assert.equal(
      records.items.filter(
        ({ event }) =>
          event.type === 'message.completed' &&
          event.messageId === final.messageId,
      ).length,
      2,
    );
    const messages = fixture.requests[0]!.messages as Array<{
      role: string;
      content: string | { type: string; text: string }[];
    }>;
    assert.deepEqual(
      messages.find((message) => message.role === 'user')?.content,
      [{ type: 'text', text: agentTaskMessage }],
    );
    assert(
      messages.some(
        (message) =>
          ['system', 'developer'].includes(message.role) &&
          typeof message.content === 'string' &&
          message.content.includes('{"type":"object"}'),
      ),
    );
    const first = JSON.stringify(fixture.requests[0]);
    assert.match(first, /WORKSPACE_INSTRUCTIONS/);
    assert.match(first, /WORKSPACE_SKILL_DESCRIPTION/);
    assert.doesNotMatch(first, /WORKSPACE_SKILL_BODY/);
    const tools = fixture.requests[0]!.tools as Array<{
      function: { name: string };
    }>;
    assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [
      'bash',
      'edit',
      'read',
      'write',
    ]);
    assert.match(JSON.stringify(fixture.requests[1]), /WORKSPACE_SKILL_BODY/);
  } finally {
    await fixture.close();
  }
});

test('Pi direct bash uses the project cwd and host account permissions when available', async (t) => {
  if (process.platform === 'win32') {
    try {
      getShellConfig();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('No bash shell found.')
      )
        throw error;
      t.skip('Pi cannot discover Bash on this Windows host');
      return;
    }
  }
  const f = await modelFixture([
    {
      tool: {
        name: 'bash',
        arguments: JSON.stringify({
          command: 'pwd; cat sample; cat ../sibling.txt',
        }),
      },
    },
    { content: '{"ok":true}' },
  ]);
  try {
    await writeFile(
      join(f.directory, 'sibling.txt'),
      'DIRECT_HOST_READ_MARKER',
    );
    assert.deepEqual(await f.run(), { ok: true });
    const messages = f.requests[1]!.messages as JsonObject[];
    const result = JSON.stringify(
      messages.find((message) => message.role === 'tool'),
    );
    assert.match(result, /workspace/);
    assert.match(result, /authorized evidence/);
    assert.match(result, /DIRECT_HOST_READ_MARKER/);
  } finally {
    await f.close();
  }
});

test('Pi sends configured reasoning and output limits with final JSON', async () => {
  const f = await modelFixture([{}], {
    contextWindow: 262144,
    maxTokens: 32768,
    thinkingLevel: 'low',
  });
  try {
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests[0]!.reasoning_effort, 'low');
    assert.equal(
      f.requests[0]!.max_completion_tokens ?? f.requests[0]!.max_tokens,
      32768,
    );
    assert.deepEqual(f.charges, [1]);
  } finally {
    await f.close();
  }
});

test('Pi preserves every configured reasoning level including xhigh', async () => {
  for (const thinkingLevel of [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ] as const) {
    const f = await modelFixture([{}], { thinkingLevel });
    try {
      assert.deepEqual(await f.run(), { ok: true });
      assert.equal(
        f.requests[0]!.reasoning_effort,
        thinkingLevel === 'off' ? undefined : thinkingLevel,
      );
    } finally {
      await f.close();
    }
  }
});

test('Pi rejects invalid settings at creation before resolving credentials or invoking a model', async () => {
  const f = await modelFixture([{}]);
  try {
    const invalidConfigs: JsonObject[] = [
      { thinkingLevel: 'invalid' },
      { bashMode: 'invalid' },
      { modelEnv: 'OLD_MODEL' },
      { api_key: 'literal-secret' },
      { contextWindow: 0 },
      { contextWindow: 8192, maxTokens: 32768 },
      { retries: -1 },
      { retries: 11 },
      { maxTokens: 262145 },
      { retryBaseDelayMs: -1 },
      { retryBaseDelayMs: 300001 },
      { settings: { compaction: { keepRecentTokens: -1 } } },
      { settings: { compaction: { keepRecentTokens: 1.5 } } },
      {
        settings: {
          compaction: { keepRecentTokens: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
      { settings: { compaction: { reserveTokens: 200 } } },
      { settings: { retries: 2 } },
    ];
    for (const invalid of invalidConfigs) {
      await assert.rejects(
        f.definition.create(invalid, f.services),
        /thinkingLevel|bashMode|contextWindow|retries|retryBaseDelayMs|maxTokens|api_key|keepRecentTokens|additional properties/,
      );
    }
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.charges, []);
  } finally {
    await f.close();
  }
});

test('Pi retries transient failures once per charged attempt', async () => {
  for (const status of [429, 503]) {
    const f = await modelFixture([{ status }, {}], {
      retries: 1,
      retryBaseDelayMs: 0,
    });
    try {
      assert.deepEqual(await f.run(), { ok: true });
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.charges, [1, 1]);
    } finally {
      await f.close();
    }
  }
});

test('Pi authentication failure is terminal even when provider text suggests retry', async () => {
  for (const status of [401, 403]) {
    const f = await modelFixture(
      [{ status, content: 'Rate limit; please retry your request' }],
      { retries: 2, retryBaseDelayMs: 0 },
    );
    try {
      await assert.rejects(f.run(), new RegExp(String(status)));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.charges, [1]);
    } finally {
      await f.close();
    }
  }
});

test('Pi defaults to low reasoning and disables transport or session retries', async () => {
  const f = await modelFixture([{ status: 429 }]);
  try {
    await assert.rejects(f.run(), /429/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.reasoning_effort, 'low');
    assert.equal(
      f.requests[0]!.max_completion_tokens ?? f.requests[0]!.max_tokens,
      undefined,
    );
    assert.deepEqual(f.charges, [1]);
    assert.equal(f.chargeAttempts(), 1);
  } finally {
    await f.close();
  }
});

test('Pi does not retry permanent HTTP errors containing misleading transient error text', async () => {
  for (const status of [400, 404, 422]) {
    const f = await modelFixture(
      [
        {
          status,
          content:
            'Invalid request: max_tokens must be less than 500000. Please retry.',
        },
      ],
      { retries: 1, retryBaseDelayMs: 0 },
    );
    try {
      await assert.rejects(f.run(), new RegExp(String(status)));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.charges, [1]);
    } finally {
      await f.close();
    }
  }
});

test('Pi applies timeout independently to tool continuation requests', async () => {
  const f = await modelFixture(
    [{ read: true, delayMs: 700 }, { delayMs: 700 }],
    { timeoutMs: 1000 },
  );
  try {
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.charges, [1, 1]);
    assert.match(JSON.stringify(f.requests[1]), /authorized evidence/);
  } finally {
    await f.close();
  }
});

test('Pi retry backoff does not consume the next request timeout', async () => {
  const f = await modelFixture([{ status: 503 }, {}], {
    retries: 1,
    retryBaseDelayMs: 350,
    timeoutMs: 200,
  });
  try {
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.charges, [1, 1]);
  } finally {
    await f.close();
  }
});

test('Pi timeout closes a stalled request without retry and permits a fresh execution', async () => {
  const f = await modelFixture([{ stall: true }, {}], {
    retries: 2,
    retryBaseDelayMs: 0,
    timeoutMs: 200,
  });
  try {
    await assert.rejects(f.run(), /timeout|timed out|aborted/i);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
    await f.waitForResponseClose(0);
    assert.equal(f.disconnected(), 1);
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});

test('Pi budget denial prevents a retry even when its error looks transient', async () => {
  const f = await modelFixture(
    [{ status: 503 }],
    { retries: 2, retryBaseDelayMs: 0 },
    1,
  );
  try {
    await assert.rejects(f.run(), /Budget rejected 503/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
    assert.equal(f.chargeAttempts(), 2);
  } finally {
    await f.close();
  }
});

test('Pi validates per-request timeouts before charging and accepts the timer maximum', async () => {
  const f = await modelFixture([{}], { timeoutMs: 2147483647 });
  try {
    for (const timeoutMs of [0, -1, 1.5, 2147483648])
      await assert.rejects(
        f.definition.create({ timeoutMs }, f.services),
        /timeoutMs/,
      );
    assert.deepEqual(f.charges, []);
    assert.deepEqual(await f.run(), { ok: true });
  } finally {
    await f.close();
  }
});

test('Pi exhausts only its configured transient retries', async () => {
  const f = await modelFixture([{ status: 503 }], {
    retries: 2,
    retryBaseDelayMs: 0,
  });
  try {
    await assert.rejects(f.run(), /503/);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.charges, [1, 1, 1]);
  } finally {
    await f.close();
  }
});

test('Pi cancellation during retry backoff prevents further attempts', async () => {
  const f = await modelFixture([{ status: 503 }], {
    retries: 2,
    retryBaseDelayMs: 1000,
  });
  try {
    const pending = f.run();
    void pending.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!f.requests.length && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await f.waitForResponseClose(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    f.controller.abort(new Error('Fixture cancelled'));
    await assert.rejects(pending, /Fixture cancelled/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
  } finally {
    await f.close();
  }
});

test('Pi rejects invalid final JSON without an RSI correction call', async () => {
  const f = await modelFixture([{ content: 'invalid JSON' }, {}]);
  try {
    await assert.rejects(f.run(), /JSON/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
  } finally {
    await f.close();
  }
});

test('Pi compacts a completed conversation without an RSI correction call', async () => {
  const result = { ok: true, findings: 'x'.repeat(90000) };
  const f = await modelFixture([
    { read: true },
    { content: JSON.stringify(result), contextTokens: 260000 },
    { content: 'Compacted task: return the requested JSON.' },
  ]);
  try {
    assert.deepEqual(await f.execute(join(f.directory, 'workspace')), result);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.charges, [1, 1, 1]);
    assert.match(
      JSON.stringify(f.requests[2]),
      /context summarization assistant/,
    );
  } finally {
    await f.close();
  }
});

test('Pi retains recent conversation within the configured compaction token target', async () => {
  const config = { settings: { compaction: { keepRecentTokens: 100000 } } };
  validate(piDefinition.configSchema, structuredClone(config));
  const result = { ok: true, findings: 'x'.repeat(90000) };
  const f = await modelFixture(
    [
      { read: true },
      { content: JSON.stringify(result), contextTokens: 260000 },
      { content: 'Unexpected compaction.' },
    ],
    config,
  );
  try {
    assert.deepEqual(await f.execute(join(f.directory, 'workspace')), result);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.charges, [1, 1]);
  } finally {
    await f.close();
  }
});

test('Pi cancellation interrupts a native child model request', async () => {
  const f = await modelFixture([
    {
      tool: {
        name: 'subagent',
        arguments: '{"agent":"scout","task":"Inspect"}',
      },
    },
    { stall: true },
  ]);
  try {
    await mkdir(join(f.directory, 'workspace/roles'));
    await writeFile(
      join(f.directory, 'workspace/roles/scout.md'),
      'Inspect evidence.',
    );
    const pending = f.run();
    void pending.catch(() => {});
    const deadline = Date.now() + 3000;
    while (f.requests.length < 2 && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(f.requests.length, 2);
    f.controller.abort(new Error('Parent cancelled'));
    await assert.rejects(pending, /Parent cancelled/);
    await f.waitForResponseClose(1);
    assert.deepEqual(f.charges, [1, 1]);
  } finally {
    await f.close();
  }
});

test('Pi records delegation and final responses for both runs', async () => {
  const f = await modelFixture([
    {
      tool: {
        name: 'subagent',
        arguments: '{"agent":"scout","task":"Inspect"}',
      },
    },
    { content: '{"findings":"Observed"}' },
    { content: '{"ok":true}' },
  ]);
  try {
    await mkdir(join(f.directory, 'workspace/roles'));
    await writeFile(
      join(f.directory, 'workspace/roles/scout.md'),
      'Inspect evidence.',
    );
    assert.deepEqual(await f.run(), { ok: true });
    const directory = join(f.directory, 'call-0');
    const records = await readAgentRecords(directory, 0, 100, true);
    const delegation = records.items.find(
      ({ runId, event }) =>
        runId === 'main' && event.type === 'subagent.activity',
    )?.event;
    assert.equal(delegation?.type, 'subagent.activity');
    const child = await readAgentRecords(
      directory,
      0,
      100,
      true,
      delegation.childRunId,
    );
    assert.equal(child.submitted?.event.type, 'task.submitted');
    assert.equal(child.submitted.event.text, 'Inspect');
    assert.equal(child.delegation?.message, 'Inspect');
    assert.deepEqual(
      child.finalResponses.map(({ runId }) => runId),
      [delegation.childRunId, 'main'],
    );
  } finally {
    await f.close();
  }
});

test('Pi compaction respects the shared budget and cancellation', async () => {
  const replies: Reply[] = [
    { read: true },
    {
      content: JSON.stringify({ ok: true, findings: 'x'.repeat(90000) }),
      contextTokens: 260000,
    },
    { stall: true },
  ];
  const denied = await modelFixture(replies, {}, 2);
  try {
    await assert.rejects(
      denied.execute(join(denied.directory, 'workspace')),
      /Budget rejected/,
    );
    assert.equal(denied.requests.length, 2);
    assert.deepEqual(denied.charges, [1, 1]);
  } finally {
    await denied.close();
  }
  const cancelled = await modelFixture(replies);
  try {
    const pending = cancelled.execute(join(cancelled.directory, 'workspace'));
    void pending.catch(() => {});
    const deadline = Date.now() + 3000;
    while (cancelled.requests.length < 3 && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled.requests.length, 3);
    cancelled.controller.abort(new Error('Compaction cancelled'));
    await assert.rejects(pending, /Compaction cancelled/);
    await cancelled.waitForResponseClose(2);
    assert.deepEqual(cancelled.charges, [1, 1, 1]);
  } finally {
    await cancelled.close();
  }
});

test('Pi retains config.executionTimeoutMs separately from the model request timeout', async () => {
  const f = await modelFixture([{ stall: true }], {
    executionTimeoutMs: 50,
    timeoutMs: 5000,
  });
  try {
    await assert.rejects(f.run(), /execution timed out/);
    assert.equal(f.controller.signal.aborted, false);
  } finally {
    await f.close();
  }
});
