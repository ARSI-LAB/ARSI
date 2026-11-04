import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { createRuntime, validateRecipe } from '../../src/runtime/context.js';
import { loadRecipe } from '../../src/runtime/loaders/index.js';
import { stringify } from 'yaml';
import { FileFacts } from '../../src/runtime/storage/index.js';

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

function toolEvents(args: unknown, serial = 0): string {
  const item = {
    type: 'function_call',
    id: `fc_read_${serial}`,
    call_id: `call_read_${serial}`,
    name: 'read_file',
    arguments: JSON.stringify(args),
  };
  return [
    {
      type: 'response.created',
      response: { id: 'resp_read', status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp_read', status: 'completed', output: [item] },
    },
  ]
    .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
    .join('');
}

async function fixture(
  replies: string[],
  options: {
    model?: string;
    files?: Record<string, string>;
    externalInstructions?: boolean;
    prompt?: string;
    budget?: number;
    timeoutMs?: number;
    thinkingLevel?: 'off' | 'low';
    chatgpt?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-codex-test-'));
  const requests: JsonObject[] = [];
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (options.chatgpt && req.url !== '/backend-api/codex/responses') {
      res.writeHead(404).end();
      return;
    }
    assert.equal(
      req.url,
      options.chatgpt ? '/backend-api/codex/responses' : '/v1/responses',
    );
    if (options.chatgpt && process.env.RSI_TEST_CODEX_EXECUTABLE)
      assert.ok(req.headers.authorization?.startsWith('Bearer eyJ'));
    else assert.equal(req.headers.authorization, 'Bearer test-codex-key');
    assert.equal(req.headers['x-rsi-codex'], undefined);
    assert.equal(
      req.headers['chatgpt-account-id'],
      options.chatgpt ? 'test-account' : undefined,
    );
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
      reply === 'CONTEXT'
        ? 'data: ' +
            JSON.stringify({
              type: 'response.failed',
              response: {
                error: {
                  code: 'context_length_exceeded',
                  message:
                    'Your input exceeds the context window; secret-diagnostic',
                },
              },
            }) +
            '\n\n'
        : reply.startsWith('READ:')
          ? toolEvents(JSON.parse(reply.slice(5)), requests.length)
          : reply === 'TOOL'
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
  const providerId = options.chatgpt ? 'openai' : 'configured';
  const codexHome = join(directory, 'user-codex');
  await mkdir(codexHome);
  const localConfig = {
    auditDirectory: directory,
    auditChatgpt: options.chatgpt ?? false,
    model: 'configured-model',
    model_provider: providerId,
    model_reasoning_effort: options.thinkingLevel ?? 'high',
    model_providers: {
      [providerId]: {
        name: 'Configured provider',
        base_url: `http://127.0.0.1:${address.port}/v1`,
        env_key: 'RSI_CODEX_TEST_KEY',
        wire_api: 'responses',
      },
    },
    chatgpt_base_url: `http://127.0.0.1:${address.port}/backend-api`,
    mcp_servers: {
      'test.server': { command: 'must-not-start', required: true },
    },
  };
  await writeFile(join(codexHome, 'fixture.json'), JSON.stringify(localConfig));
  await writeFile(
    join(codexHome, 'auth.json'),
    '{"auth_mode":"apikey","OPENAI_API_KEY":"test-codex-key"}',
  );
  if (options.chatgpt) {
    const payload = {
      exp: 4102444800,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'test-account',
        chatgpt_plan_type: 'plus',
        chatgpt_user_id: 'test-user',
      },
    };
    const jwt =
      'eyJhbGciOiJub25lIn0.' +
      Buffer.from(JSON.stringify(payload)).toString('base64url') +
      '.test';
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: 'test-refresh',
          account_id: 'test-account',
        },
        last_refresh: new Date().toISOString(),
      }),
    );
  }
  await writeFile(
    join(codexHome, 'config.toml'),
    [
      'model = "configured-model"',
      `model_provider = "${providerId}"`,
      `model_reasoning_effort = "${options.thinkingLevel ?? 'high'}"`,
      `[model_providers.${providerId}]`,
      'name = "Configured provider"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'env_key = "RSI_CODEX_TEST_KEY"',
      'wire_api = "responses"',
    ].join('\n'),
  );
  if (options.chatgpt) {
    await writeFile(
      join(codexHome, 'config.toml'),
      [
        'model = "configured-model"',
        'model_reasoning_effort = "high"',
        `chatgpt_base_url = "http://127.0.0.1:${address.port}/backend-api"`,
      ].join('\n'),
    );
  }
  if (options.externalInstructions) {
    const outside = join(codexHome, 'outside.md');
    await writeFile(outside, 'OUTSIDE_SNAPSHOT_SENTINEL');
    const path = join(codexHome, 'config.toml');
    await writeFile(
      path,
      `model_instructions_file=${JSON.stringify(outside)}\ndeveloper_instructions="OUTSIDE_DEVELOPER_SENTINEL"\n` +
        (await readFile(path, 'utf8')),
    );
  }
  const executable = join(directory, 'codex-test.cjs');
  await writeFile(
    executable,
    await readFile(resolve('tests/fixtures/codex-cli.cjs')),
  );
  await chmod(executable, 0o700);
  const previous = {
    key: process.env.RSI_CODEX_TEST_KEY,
    home: process.env.CODEX_HOME,
  };
  process.env.RSI_CODEX_TEST_KEY = 'test-codex-key';
  process.env.CODEX_HOME = codexHome;
  let charges = 0;
  const context = new RuntimeContext().extend({
    directory,
    experimentId: 'codex-fixture',
    bindingId: 'agent',
    facts: new FileFacts(join(directory, 'facts')),
    signal: controller.signal,
    charge: async (metric: string, amount: number) => {
      assert.equal(metric, 'modelCalls');
      assert.equal(amount, 1);
      if (charges >= (options.budget ?? Infinity))
        throw new Error('Budget rejected');
      charges++;
    },
  });
  let operation = await createAgentCodex(
    {
      executable: process.env.RSI_TEST_CODEX_EXECUTABLE ?? executable,
      timeoutMs: options.timeoutMs ?? 20000,
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    context,
  );
  return {
    directory,
    requests,
    facts: context.facts,
    async changeLocalModel(model: string) {
      localConfig.model = model;
      await writeFile(
        join(codexHome, 'fixture.json'),
        JSON.stringify(localConfig),
      );
      const path = join(codexHome, 'config.toml');
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(
          /^model = .+$/m,
          `model = ${JSON.stringify(model)}`,
        ),
      );
    },
    async recreate() {
      await operation.dispose();
      operation = await createAgentCodex(
        {
          executable: process.env.RSI_TEST_CODEX_EXECUTABLE ?? executable,
          timeoutMs: options.timeoutMs ?? 20000,
          ...(options.model ? { model: options.model } : {}),
        },
        context,
      );
    },
    charges: () => charges,
    run: (maxModelCalls = 2) =>
      operation.execute(
        {
          goal: 'Read snapshot',
          prompt: options.prompt ?? 'Return the answer',
          files: options.files ?? {
            '/private/not-a-host-file': 'snapshot-content',
          },
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
      if (previous.key === undefined) delete process.env.RSI_CODEX_TEST_KEY;
      else process.env.RSI_CODEX_TEST_KEY = previous.key;
      if (previous.home === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.home;
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
      assert.deepEqual(
        (request.tools as { name: string }[]).map((t) => t.name),
        ['read_file'],
      );
      assert.equal(request.tool_choice, 'auto');
      assert.equal((request.reasoning as { effort: string }).effort, 'high');
      assert.equal(request.model, 'configured-model');
      assert.ok(!JSON.stringify(request.input).includes('snapshot-content'));
      assert.ok(
        JSON.stringify(request.input).includes('/private/not-a-host-file'),
      );
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
      assert.equal(execution.home, join(f.directory, 'user-codex'));
      assert.ok(
        execution.args.some((arg: string) =>
          arg.includes('\"test.server\"={enabled=false,required=false}'),
        ),
      );
      assert.ok(execution.args.includes('features.hooks=false'));
      assert.ok(execution.args.includes('features.plugins=false'));
      assert.ok(!execution.args.join(' ').includes('test-codex-key'));
      assert.equal(
        await readFile(join(execution.home, 'auth.json'), 'utf8'),
        '{"auth_mode":"apikey","OPENAI_API_KEY":"test-codex-key"}',
      );
      await assert.rejects(
        readFile(join(execution.dir, 'instructions.md')),
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
    );
    recipe.bindings.agent = { ref: 'agent.codex', config: {} };
    const path = join(directory, 'recipe.yaml');
    await writeFile(path, stringify(recipe));
    await validateRecipe(runtime, path);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const thinkingLevel of [undefined, 'off', 'low'] as const) {
  test(`Codex inherits local reasoning ${thinkingLevel ?? 'default'}`, async () => {
    const f = await fixture(['{"answer":"ok"}'], { thinkingLevel });
    try {
      assert.deepEqual(await f.run(1), { answer: 'ok' });
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.requests[0].reasoning, {
        effort: thinkingLevel ?? 'high',
      });
    } finally {
      await f.close();
    }
  });
}

test('Codex forwards local ChatGPT authentication and account headers', async () => {
  const f = await fixture(['{"answer":"ok"}'], { chatgpt: true });
  try {
    assert.deepEqual(await f.run(1), { answer: 'ok' });
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test('Codex rejects obsolete API and reasoning configuration', async () => {
  for (const field of ['base_url', 'api_key', 'thinkingLevel']) {
    await assert.rejects(
      createAgentCodex({ [field]: 'obsolete' }, new RuntimeContext()),
      /agent.codex config/,
    );
  }
});

for (const model of [undefined, 'selected-model']) {
  test(`Codex uses ${model ?? 'the local default model'}`, async () => {
    const f = await fixture(['{"answer":"ok"}'], { model });
    try {
      const path = join(f.directory, 'user-codex', 'config.toml');
      const before = await readFile(path, 'utf8');
      assert.deepEqual(await f.run(1), { answer: 'ok' });
      assert.equal(f.requests[0].model, model ?? 'configured-model');
      assert.equal(await readFile(path, 'utf8'), before);
      if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
        const execution = JSON.parse(
          await readFile(join(f.directory, 'execution.json'), 'utf8'),
        );
        assert.equal(
          execution.args.includes(`model=${JSON.stringify(model)}`),
          model !== undefined,
        );
      }
    } finally {
      await f.close();
    }
  });
}

test('Codex rejects empty model overrides', async () => {
  for (const model of ['', '   ']) {
    await assert.rejects(
      createAgentCodex({ model }, new RuntimeContext()),
      /agent.codex config/,
    );
  }
});

test('Codex reads a bounded virtual file on demand without inlining a large snapshot', async () => {
  const f = await fixture(
    [
      'READ:' + JSON.stringify({ path: 'context/huge.json', maxBytes: 4096 }),
      '{"answer":"ok"}',
    ],
    {
      files: {
        'context/huge.json':
          'needed-start-' + 'x'.repeat(4 * 1024 * 1024) + 'NOT_READ_TAIL',
      },
    },
  );
  try {
    assert.deepEqual(await f.run(2), { answer: 'ok' });
    assert.equal(f.charges(), 2);
    assert.ok(!JSON.stringify(f.requests[0].input).includes('needed-start-'));
    assert.ok(JSON.stringify(f.requests[1].input).includes('needed-start-'));
    assert.ok(!JSON.stringify(f.requests[1].input).includes('NOT_READ_TAIL'));
    assert.ok(Buffer.byteLength(JSON.stringify(f.requests[1].input)) < 20000);
  } finally {
    await f.close();
  }
});

test('Codex excludes local model and developer instruction files', async () => {
  const f = await fixture(['{"answer":"ok"}'], { externalInstructions: true });
  try {
    assert.deepEqual(await f.run(1), { answer: 'ok' });
    const body = JSON.stringify(f.requests);
    assert.ok(!body.includes('OUTSIDE_SNAPSHOT_SENTINEL'));
    assert.ok(!body.includes('OUTSIDE_DEVELOPER_SENTINEL'));
  } finally {
    await f.close();
  }
});

test('Codex records effective settings and rejects model drift across resumed instances before inference', async () => {
  const f = await fixture(['{"answer":"ok"}', '{"answer":"ok"}']);
  try {
    await f.run(1);
    const configurations = await f.facts.list('agent-codex-configurations');
    assert.equal(configurations.length, 1);
    const text = JSON.stringify(configurations);
    assert.ok(text.includes('configured-model'));
    assert.ok(!text.includes('test-codex-key'));
    assert.ok(!text.includes('127.0.0.1'));
    await f.changeLocalModel('changed-model');
    await f.recreate();
    await assert.rejects(
      f.run(1),
      /configuration changed within this experiment/,
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('Codex treats streamed context errors as terminal without exposing upstream diagnostics', async () => {
  const f = await fixture(['CONTEXT']);
  try {
    await assert.rejects(
      f.run(5),
      (error) =>
        error instanceof Error &&
        /context limit exceeded/.test(error.message) &&
        !error.message.includes('secret-diagnostic'),
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('Codex rejects oversized initial instructions before inference', async () => {
  const f = await fixture(['{"answer":"ok"}'], { prompt: 'x'.repeat(131072) });
  try {
    await assert.rejects(f.run(1), /initial task metadata exceeds byte limit/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.charges(), 0);
  } finally {
    await f.close();
  }
});

test('Codex repairs an empty final response within the same charged session', async () => {
  const f = await fixture(['', '{"answer":"ok"}']);
  try {
    assert.deepEqual(await f.run(2), { answer: 'ok' });
    assert.equal(f.charges(), 2);
    assert.ok(JSON.stringify(f.requests[1].input).includes('validationError'));
  } finally {
    await f.close();
  }
});

test('Codex distinguishes numeric server tool requests from client responses with the same IDs', async () => {
  const f = await fixture(
    [
      'READ:' + JSON.stringify({ path: 'one.txt' }),
      'READ:' + JSON.stringify({ path: 'two.txt' }),
      'READ:' + JSON.stringify({ path: 'three.txt' }),
      '{"answer":"ok"}',
    ],
    {
      files: { 'one.txt': 'first', 'two.txt': 'second', 'three.txt': 'third' },
    },
  );
  try {
    assert.deepEqual(await f.run(4), { answer: 'ok' });
    assert.equal(f.charges(), 4);
    const diagnostics = await readFile(
      join(f.directory, 'diagnostics.jsonl'),
      'utf8',
    );
    assert.equal(diagnostics.split('"type":"virtual_file_read"').length - 1, 3);
  } finally {
    await f.close();
  }
});
