import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import { createAgentPi } from '../../src/plugins/agent-pi/service.js';

async function fixture(replies: string[], chargeLimit = Infinity) {
  const requests: string[] = [];
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push(body);
    const content = replies[requests.length - 1] ?? 'invalid';
    if (content === 'ERROR') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Provider rejected test-private-key' },
        }),
      );
      return;
    }
    if (content === 'CANCEL') controller.abort(new Error('Test cancelled'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (content === 'READ') {
      res.write(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"sample"}' },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ role: 'assistant', content }, null));
      res.write(chunk({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const directory = await mkdtemp(join(tmpdir(), 'rsi-agent-json-'));
  const previous = process.env.RSI_TEST_JSON_KEY;
  process.env.RSI_TEST_JSON_KEY = 'test-private-key';
  let charges = 0;
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
    charge: async () => {
      if (charges >= chargeLimit) throw new Error('Budget rejected');
      charges++;
    },
  });
  const operation = await createAgentPi(
    {
      model: 'test',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '${RSI_TEST_JSON_KEY}',
      timeoutMs: 10000,
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
    charges: () => charges,
    run: (maxModelCalls?: number) =>
      operation.execute(
        {
          prompt: 'Return JSON.',
          goal: 'test',
          files: { sample: 'authorized text' },
          outputSchema: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false,
          },
          ...(maxModelCalls === undefined ? {} : { maxModelCalls }),
        },
        context.extend(services),
      ),
    log: () => readFile(join(directory, 'diagnostics.jsonl'), 'utf8'),
    async close() {
      await operation.dispose();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RSI_TEST_JSON_KEY;
      else process.env.RSI_TEST_JSON_KEY = previous;
    },
  };
}

test('final JSON repairs malformed and schema-invalid replies with response and error feedback', async () => {
  const f = await fixture([
    'not JSON test-private-key',
    '{"value":"wrong"}',
    '{"value":7}',
  ]);
  try {
    assert.deepEqual(await f.run(), { value: 7 });
    assert.equal(f.charges(), 3);
    const second = JSON.parse(f.requests[1]!);
    const feedback = JSON.parse(second.messages.at(-1).content[0].text);
    assert.equal(feedback.previousResponse, 'not JSON test-private-key');
    assert.match(feedback.validationError, /JSON/);
    const third = JSON.parse(f.requests[2]!);
    const schemaFeedback = JSON.parse(third.messages.at(-1).content[0].text);
    assert.equal(schemaFeedback.previousResponse, '{"value":"wrong"}');
    assert.match(schemaFeedback.validationError, /integer/);
    assert.ok(
      second.tools.every(
        (t: { function: { name: string } }) => t.function.name !== 'finish',
      ),
    );
    const log = await f.log();
    assert.match(log, /validation_failed/);
    assert.match(log, /\[REDACTED\]/);
    assert.ok(!log.includes('test-private-key'));
  } finally {
    await f.close();
  }
});

test('read_file remains available and fenced final JSON needs no finish call', async () => {
  const f = await fixture(['READ', '```json\n{"value":2}\n```']);
  try {
    assert.deepEqual(await f.run(), { value: 2 });
    assert.equal(f.charges(), 2);
    assert.match(f.requests[1]!, /authorized text/);
    assert.match(await f.log(), /read_file/);
  } finally {
    await f.close();
  }
});

test('invalid output stops at the shared model-call limit and retains the last failure', async () => {
  const f = await fixture(['{"value":"wrong"}', '{"value":"still wrong"}']);
  try {
    await assert.rejects(f.run(2), /model-call limit.*integer/s);
    assert.equal(f.requests.length, 2);
    assert.equal(f.charges(), 2);
    assert.match(await f.log(), /validation_failed/);
  } finally {
    await f.close();
  }
});

test('omitted limits allow Pi to repair output after more than 24 model calls', async () => {
  const f = await fixture([
    ...Array<string>(24).fill('{"value":"wrong"}'),
    '{"value":7}',
  ]);
  try {
    assert.deepEqual(await f.run(), { value: 7 });
    assert.equal(f.charges(), 25);
    const first = JSON.parse(f.requests[0]!);
    assert.equal(Object.hasOwn(first, 'max_tokens'), false);
    assert.equal(Object.hasOwn(first, 'max_completion_tokens'), false);
  } finally {
    await f.close();
  }
});

test('cancellation stops output recovery without another model request', async () => {
  const f = await fixture(['CANCEL']);
  try {
    await assert.rejects(f.run(), /Test cancelled/);
    assert.equal(f.requests.length, 1);
    assert.match(await f.log(), /Test cancelled/);
  } finally {
    await f.close();
  }
});

test('provider errors are redacted and do not trigger output retries', async () => {
  const f = await fixture(['ERROR']);
  try {
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /400|Provider rejected/);
      assert.ok(!error.message.includes('test-private-key'));
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.ok(!(await f.log()).includes('test-private-key'));
  } finally {
    await f.close();
  }
});

test('Manager budget denial prevents the next correction request', async () => {
  const f = await fixture(['invalid', '{"value":1}'], 1);
  try {
    await assert.rejects(f.run(), /Budget rejected/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test('final output rejects prose and result envelopes without salvaging fragments', async () => {
  for (const reply of ['Here is JSON: {"value":1}', '{"result":{"value":1}}']) {
    const f = await fixture([reply]);
    try {
      await assert.rejects(f.run(1), /last output validation failed/);
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  }
});

test('final JSON can exceed the former implicit output byte limit', async () => {
  const reply = `{"value":1}${' '.repeat(131073)}`;
  const f = await fixture([reply]);
  try {
    assert.deepEqual(await f.run(1), { value: 1 });
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});
