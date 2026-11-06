import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import {
  createAgentPi,
  resolveModelConfig,
  readVirtualFile,
} from '../../src/plugins/agent-pi/service.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import type { AgentPiConfig } from '../../src/plugins/agent-pi/schema.js';

test('Agent uses SDK model fields and resolves environment references without persisting credentials', () => {
  const env = {
    MODEL_NAME: 'test-model',
    MODEL_ENDPOINT: 'https://model.example/v1',
    MODEL_API_KEY: 'test-credential',
    MODEL_HOST: 'model.example',
  };
  const config = {};
  assert.deepEqual(resolveModelConfig(config, env), {
    model: 'test-model',
    base_url: 'https://model.example/v1',
    api_key: 'test-credential',
  });
  assert.deepEqual(config, {});
  assert.equal(
    resolveModelConfig(
      { model: 'explicit-model', base_url: 'https://${MODEL_HOST}/v1' },
      env,
    ).model,
    'explicit-model',
  );
  assert.equal(
    resolveModelConfig({ base_url: 'https://${MODEL_HOST}/v1' }, env).base_url,
    'https://model.example/v1',
  );
  assert.throws(() => resolveModelConfig({}, {}), /MODEL_NAME/);
  assert.throws(
    () => resolveModelConfig({}, { ...env, MODEL_API_KEY: '  ' }),
    /api_key.*empty/,
  );
  assert.throws(
    () => resolveModelConfig({ api_key: 'literal-secret' }, env),
    /api_key/,
  );
});

interface Reply {
  contextTokens?: number;
  status?: number;
  content?: string;
  read?: boolean;
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
      reply.read
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"sample"}' },
              },
            ],
          }
        : { role: 'assistant', content: reply.content ?? '{"ok":true}' },
      null,
    ) +
      chunk({}, reply.read ? 'tool_calls' : 'stop') +
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
  const operation = await createAgentPi(
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
  return {
    requests,
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
    run: (maxModelCalls = 8) =>
      operation.execute(
        {
          prompt:
            'Read the supplied evidence if needed, then return only JSON.',
          goal: 'Return the fixture result.',
          files: { sample: 'authorized evidence' },
          outputSchema: {
            type: 'object',
            properties: { ok: { const: true } },
            required: ['ok'],
            additionalProperties: false,
          },
          maxModelCalls,
        },
        context.extend(services),
      ),
    log: () => readFile(join(directory, 'diagnostics.jsonl'), 'utf8'),
    async close() {
      controller.abort();
      await operation.dispose();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RSI_PI_TEST_KEY;
      else process.env.RSI_PI_TEST_KEY = previous;
    },
  };
}

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
    const definition: OperationDefinition = piDefinition;
    const invalidConfigs: JsonObject[] = [
      { thinkingLevel: 'invalid' },
      { modelEnv: 'OLD_MODEL' },
      { contextWindow: 0 },
      { contextWindow: 8192, maxTokens: 32768 },
      { retries: -1 },
      { maxTokens: 262145 },
      { retryBaseDelayMs: -1 },
      { retryBaseDelayMs: 2147483648 },
    ];
    for (const invalid of invalidConfigs) {
      await assert.rejects(
        definition.create(invalid, f.services),
        /thinkingLevel|contextWindow|retries|retryBaseDelayMs|maxTokens|additional properties/,
      );
    }
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.charges, []);
  } finally {
    await f.close();
  }
});

test('Pi accepts configured retry counts and delays above former fixed ceilings without model execution', async () => {
  const context = new RuntimeContext();
  const operation = await createAgentPi(
    { retries: 11, retryBaseDelayMs: 300001 },
    context,
  );
  await operation.dispose();
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
      assert.match(await f.log(), /auto_retry_start/);
    } finally {
      await f.close();
    }
  }
});

test('Pi exhausts only its configured retries and preserves redacted failure diagnostics', async () => {
  const f = await modelFixture(
    [{ status: 503, content: 'Unavailable fixture-private-key' }],
    { retries: 2, retryBaseDelayMs: 0 },
  );
  try {
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /503/);
      assert.ok(!error.message.includes('fixture-private-key'));
      return true;
    });
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.charges, [1, 1, 1]);
    assert.ok(!(await f.log()).includes('fixture-private-key'));
  } finally {
    await f.close();
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

test('Pi compacts large contexts by default and charges summary calls to the same budget', async () => {
  const replies: Reply[] = [
    { read: true },
    { content: 'x'.repeat(90000), contextTokens: 240000 },
    { content: 'The task requires returning {"ok":true}.' },
    {},
  ];
  const f = await modelFixture(replies);
  try {
    assert.deepEqual(await f.run(), { ok: true });
    assert.match(await f.log(), /compaction_end/);
    assert.ok(
      f.requests.some((request) =>
        JSON.stringify(request.messages).includes('<conversation>'),
      ),
    );
    assert.equal(f.charges.length, f.requests.length);
  } finally {
    await f.close();
  }
});

test('Pi compaction respects Manager budget denial and cancellation', async () => {
  const replies: Reply[] = [
    { read: true },
    { content: 'x'.repeat(90000), contextTokens: 240000 },
    { stall: true },
  ];
  const denied = await modelFixture(replies, {}, 2);
  try {
    await assert.rejects(denied.run(), /Budget rejected/);
    assert.equal(denied.requests.length, 2);
    assert.deepEqual(denied.charges, [1, 1]);
  } finally {
    await denied.close();
  }
  const cancelled = await modelFixture(replies);
  try {
    const result = assert.rejects(cancelled.run(), /abort|cancel/i);
    const deadline = Date.now() + 3000;
    while (cancelled.requests.length < 3 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(cancelled.requests.length, 3);
    cancelled.controller.abort();
    await result;
    assert.equal(cancelled.requests.length, 3);
    assert.deepEqual(cancelled.charges, [1, 1, 1]);
  } finally {
    await cancelled.close();
  }
});

test('Pi validates request and execution timeouts before charging and accepts the timer maximum', async () => {
  const f = await modelFixture([{ delayMs: 20 }], {
    timeoutMs: 2147483647,
    executionTimeoutMs: 2147483647,
  });
  try {
    for (const field of ['timeoutMs', 'executionTimeoutMs'])
      for (const value of [0, -1, 1.5, 2147483648])
        await assert.rejects(
          createAgentPi({ [field]: value }, f.services),
          new RegExp(field),
        );
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.charges, []);
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
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

test('Pi execution timeout spans tool continuations and output corrections', async () => {
  for (const first of [{ read: true }, { content: 'invalid' }]) {
    const f = await modelFixture(
      [{ ...first, delayMs: 300 }, { delayMs: 300 }],
      { timeoutMs: 2000, executionTimeoutMs: 500 },
    );
    try {
      await assert.rejects(f.run(), /Agent execution timed out/);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.charges, [1, 1]);
      assert.equal(f.controller.signal.aborted, false);
    } finally {
      await f.close();
    }
  }
});

test('Pi execution timeout closes stalled requests without retry and permits a fresh execution', async () => {
  const f = await modelFixture([{ stall: true }, {}], {
    executionTimeoutMs: 200,
    retries: 2,
    retryBaseDelayMs: 0,
  });
  try {
    await assert.rejects(f.run(), /Agent execution timed out/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
    assert.equal(f.controller.signal.aborted, false);
    await f.waitForResponseClose(0);
    assert.equal(f.disconnected(), 1);
    assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.charges, [1, 1]);
  } finally {
    await f.close();
  }
});

test('Pi execution timeout includes retry backoff and prevents the next attempt', async () => {
  const f = await modelFixture([{ status: 503 }, {}], {
    executionTimeoutMs: 200,
    retries: 2,
    retryBaseDelayMs: 1000,
  });
  try {
    await assert.rejects(f.run(), /Agent execution timed out/);
    assert.match(await f.log(), /auto_retry_start/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
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
    while (
      !(await f.log().catch(() => '')).includes('auto_retry_start') &&
      Date.now() < deadline
    ) {
      await new Promise<void>((done) => setTimeout(done, 10));
    }
    assert.match(await f.log(), /auto_retry_start/);
    f.controller.abort(new Error('Fixture cancelled'));
    await assert.rejects(pending, /Fixture cancelled/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.charges, [1]);
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

test('Pi retries share the model-call cap with output correction', async () => {
  const f = await modelFixture([{ status: 503 }, { content: 'invalid' }, {}], {
    retries: 2,
    retryBaseDelayMs: 0,
  });
  try {
    await assert.rejects(f.run(2), /model-call limit.*validation failed/);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.charges, [1, 1]);
  } finally {
    await f.close();
  }
});
test('virtual evidence supports bounded line ranges without reading host paths', () => {
  const files = {
    log: Array.from({ length: 1000 }, (_, n) => `event-${n + 1}`).join('\n'),
    empty: '',
  };
  const excerpt = readVirtualFile(files, {
    path: 'log',
    startLine: 501,
    lineCount: 2,
  });
  assert.match(excerpt, /Lines 501-502 of 1000; more=true/);
  assert.match(excerpt, /event-501\nevent-502$/);
  assert.equal(readVirtualFile(files, { path: 'empty' }), '');
  assert.throws(
    () => readVirtualFile(files, { path: '/etc/passwd' }),
    /authorized/,
  );
  assert.throws(
    () => readVirtualFile(files, { path: 'log', lineCount: 501 }),
    /range/,
  );
});
