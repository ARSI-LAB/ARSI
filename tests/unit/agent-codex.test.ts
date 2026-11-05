import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { createRuntime, validateRecipe } from '../../src/runtime/context.js';
import { loadRecipe } from '../../src/runtime/loaders/index.js';
import { stringify } from 'yaml';
import { object } from '../../src/shared/json.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
function events(text: string): string {
  const item = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  };
  return [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
}

async function fixture(
  replies: string[],
  options: {
    budget?: number;
    timeoutMs?: number;
    thinkingLevel?: 'off' | 'low';
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-codex-test-'));
  const requests: JsonObject[] = [];
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer test-codex-key');
    requests.push(JSON.parse(body));
    const reply = replies[requests.length - 1] ?? 'invalid';
    if (reply === 'WAIT') return;
    if (reply === 'CANCEL') {
      controller.abort(new Error('Test cancelled'));
      return;
    }
    if (reply === 'ERROR') {
      res.writeHead(400).end('test-codex-key');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      reply === 'TOOL'
        ? 'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"exec_command","arguments":"{}"}}\n\n'
        : events(reply),
    );
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const executable = join(directory, 'codex-test.cjs');
  // A deterministic CLI double; opt into the installed real CLI in a separate integration invocation.
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
(async () => {
  const dir = process.cwd();
  fs.writeFileSync(${JSON.stringify(join(directory, 'execution.json'))}, JSON.stringify({ dir, env: Object.keys(process.env) }));
  const config = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
  const base = JSON.parse(/^base_url = (.+)$/m.exec(config)[1]);
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const response = await fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.RSI_CODEX_TOKEN }, body: JSON.stringify({ input: prompt, reasoning: { effort: 'low' }, tools: [{ type: 'function', name: 'exec_command' }] }) });
  if (!response.ok) process.exit(1);
  const body = await response.text();
  const events = body.split('\\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
  const final = events.find(x => x.type === 'response.completed');
  fs.writeFileSync(dir + '/output.json', final.response.output[0].content[0].text);
})().catch(() => process.exit(1));
`,
  );
  await chmod(executable, 0o700);
  const previous = process.env.RSI_CODEX_TEST_KEY;
  process.env.RSI_CODEX_TEST_KEY = 'test-codex-key';
  let charges = 0;
  const context = new RuntimeContext().extend({
    directory,
    signal: controller.signal,
    charge: async (metric: string, amount: number) => {
      assert.equal(metric, 'modelCalls');
      assert.equal(amount, 1);
      if (charges >= (options.budget ?? Infinity))
        throw new Error('Budget rejected');
      charges++;
    },
  });
  const operation = await createAgentCodex(
    {
      executable: process.env.RSI_TEST_CODEX_EXECUTABLE ?? executable,
      model: 'gpt-5.4',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '${RSI_CODEX_TEST_KEY}',
      timeoutMs: options.timeoutMs ?? 20000,
      ...(options.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: options.thinkingLevel }),
    },
    context,
  );
  return {
    directory,
    requests,
    charges: () => charges,
    run: (maxModelCalls = 2) =>
      operation.execute(
        {
          goal: 'Read snapshot',
          prompt: 'Return the answer',
          files: { '/private/not-a-host-file': 'snapshot-content' },
          outputSchema: schema,
          maxModelCalls,
        },
        context,
      ),
    async close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await operation.dispose();
      if (previous === undefined) delete process.env.RSI_CODEX_TEST_KEY;
      else process.env.RSI_CODEX_TEST_KEY = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Codex receives virtual files, charges each request, repairs invalid JSON and cleans isolated execution state', async () => {
  const f = await fixture(['{"answer":3}', '{"answer":"ok"}']);
  try {
    assert.deepEqual(await f.run(), { answer: 'ok' });
    assert.equal(f.charges(), 2);
    for (const request of f.requests) {
      assert.deepEqual(request.tools, []);
      assert.equal(request.tool_choice, 'none');
      assert.equal(Object.hasOwn(request, 'reasoning'), false);
      assert.ok(JSON.stringify(request.input).includes('snapshot-content'));
    }
    const diagnostics = await readFile(
      join(f.directory, 'diagnostics.jsonl'),
      'utf8',
    );
    assert.ok(diagnostics.includes('validation_failed'));
    assert.ok(!diagnostics.includes('test-codex-key'));
    assert.ok(!diagnostics.includes('snapshot-content'));
    if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
      const execution = JSON.parse(
        await readFile(join(f.directory, 'execution.json'), 'utf8'),
      );
      assert.ok(!execution.env.includes('RSI_CODEX_TEST_KEY'));
      await assert.rejects(
        readFile(join(execution.dir, 'output.json')),
        /ENOENT/,
      );
    }
  } finally {
    await f.close();
  }
});

for (const scenario of [
  {
    name: 'budget denial',
    replies: ['{"answer":"ok"}'],
    options: { budget: 0 },
    error: /Budget rejected/,
    calls: 0,
  },
  {
    name: 'model-call limit',
    replies: ['invalid'],
    options: {},
    error: /model-call limit/,
    calls: 1,
  },
  {
    name: 'provider failure',
    replies: ['ERROR'],
    options: {},
    error: /HTTP 400/,
    calls: 1,
  },
  {
    name: 'forbidden host tool',
    replies: ['TOOL'],
    options: {},
    error: /forbidden tool/,
    calls: 1,
  },
  {
    name: 'cancellation',
    replies: ['CANCEL'],
    options: {},
    error: /Test cancelled/,
    calls: 1,
  },
  {
    name: 'timeout',
    replies: ['WAIT'],
    options: { timeoutMs: 1000 },
    error: /timed out/,
    calls: 1,
  },
]) {
  test(`Codex enforces ${scenario.name}`, async () => {
    const f = await fixture(scenario.replies, scenario.options);
    try {
      await assert.rejects(f.run(1), scenario.error);
      assert.equal(f.requests.length, scenario.calls);
      assert.equal(f.charges(), scenario.calls);
    } finally {
      await f.close();
    }
  });
}

test('existing Policy accepts Codex Recipe binding without business-plugin changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-codex-recipe-'));
  const runtime = await createRuntime({ rootDirectory: directory });
  try {
    assert.equal(
      runtime.registry.get('agent.codex').contract.id,
      'contract.agent',
    );
    const recipe = await loadRecipe(
      resolve('examples/harness/dsh-wikiskill/recipe.yaml'),
      runtime.registry,
    );
    const declaration = recipe.toJSON();
    object(declaration.bindings).agent = { plugin: 'agent.codex', config: {} };
    const path = join(directory, 'recipe.yaml');
    await writeFile(path, stringify(declaration));
    await validateRecipe(runtime, path);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const thinkingLevel of [undefined, 'off', 'low'] as const) {
  test(`Codex thinkingLevel ${thinkingLevel ?? 'default'} matches Pi reasoning controls`, async () => {
    const f = await fixture(['{"answer":"ok"}'], { thinkingLevel });
    try {
      assert.deepEqual(await f.run(1), { answer: 'ok' });
      assert.equal(f.requests.length, 1);
      if (thinkingLevel === 'low') {
        assert.equal(
          (f.requests[0].reasoning as { effort: string }).effort,
          'low',
        );
      } else {
        assert.equal(Object.hasOwn(f.requests[0], 'reasoning'), false);
      }
    } finally {
      await f.close();
    }
  });
}
