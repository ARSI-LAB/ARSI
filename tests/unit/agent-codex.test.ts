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
    model?: string;
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
  const providerId = options.chatgpt ? 'openai' : 'configured';
  const codexHome = join(directory, 'user-codex');
  await mkdir(codexHome);
  const localConfig = {
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
  const executable = join(directory, 'codex-test.cjs');
  // A deterministic CLI double; the optional real CLI uses only this temporary provider.
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + '/fixture.json', 'utf8'));
if (process.argv.includes('app-server')) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    const request = JSON.parse(line);
    if (request.id) process.stdout.write(JSON.stringify({ id: request.id, result: request.id === 1 ? {} : { config } }) + '\\n');
  });
} else (async () => {
  const dir = process.cwd();
  const args = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(join(directory, 'execution.json'))}, JSON.stringify({ dir, home: process.env.CODEX_HOME, args }));
  const overrides = Object.fromEntries(args.flatMap((value, i) => {
    if (args[i-1] !== '-c') return [];
    const eq = value.indexOf('=');
    return [[value.slice(0, eq), value.slice(eq+1)]];
  }));
  const key = 'model_providers.' + (config.model_provider === 'openai' ? 'rsi-local-openai' : config.model_provider);
  const base = JSON.parse(overrides[key + '.base_url']);
  const token = JSON.parse(overrides[key + '.http_headers.X-RSI-Codex']);
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const response = await fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.RSI_CODEX_TEST_KEY, 'X-RSI-Codex': token, ${options.chatgpt ? "'chatgpt-account-id': 'test-account'," : ''} }, body: JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : config.model, input: prompt, reasoning: { effort: config.model_reasoning_effort }, tools: [{ type: 'function', name: 'exec_command' }] }) });
  if (!response.ok) process.exit(1);
  const body = await response.text();
  const events = body.split('\\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
  const final = events.find(x => x.type === 'response.completed');
  fs.writeFileSync(dir + '/output.json', final.response.output[0].content[0].text);
})().catch(() => process.exit(1));
`,
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
      timeoutMs: options.timeoutMs ?? 20000,
      ...(options.model === undefined ? {} : { model: options.model }),
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
      assert.deepEqual(request.tools, []);
      assert.equal(request.tool_choice, 'none');
      assert.equal((request.reasoning as { effort: string }).effort, 'high');
      assert.equal(request.model, 'configured-model');
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
        assert.equal(execution.args.includes('--model'), model !== undefined);
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
