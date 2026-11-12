import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { proposerEditOutputSchema } from '../../src/plugins/proposer-agent/edits.js';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { configSchema } from '../../src/plugins/agent-codex/schema.js';
import { parseConfig } from '../../src/shared/schema.js';
import { createRuntime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { stringify } from 'yaml';
import { object } from '../../src/shared/json.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

test('Codex directs role delegation through its native tool', async () => {
  const f = await fixture(['{"answer":"ok"}']);
  try {
    await assert.rejects(f.run('scout'), /use native spawn_agent/);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

function events(reply: string, serial: number): string {
  const spawn = reply.startsWith('SPAWN:');
  const item = spawn
    ? {
        id: `fc_${serial}`,
        type: 'function_call' as const,
        call_id: `call_${serial}`,
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        arguments: reply.slice(6),
      }
    : {
        id: `msg_${serial}`,
        type: 'message' as const,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: reply, annotations: [] }],
      };
  const response = {
    id: `resp_${serial}`,
    object: 'response',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  };
  const rows: unknown[] = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        ...item,
        ...(item.type === 'function_call'
          ? { arguments: '' }
          : { content: [] }),
      },
    },
  ];
  if (item.type === 'function_call')
    rows.push(
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
    );
  else
    rows.push(
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
        delta: reply,
      },
      {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: reply,
      },
    );
  rows.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  );
  return rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join('');
}
async function fixture(
  replies: string[],
  options: {
    model?: string;
    thinkingLevel?: string;
    timeoutMs?: number;
    retries?: number;
    approvalRequired?: boolean;
    rpcError?: boolean;
    turnFailure?: boolean;
    outputSchema?: JsonObject;
    nativeDelegate?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-native-'));
  const home = join(directory, 'home');
  const cwd = join(directory, 'project');
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS');
  await writeFile(join(cwd, '.rsi-project'), '');
  const requests: JsonObject[] = [];
  const controller = new AbortController();
  let childStarted = (): void => {};
  const child = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push(JSON.parse(body));
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(req.headers['x-rsi-codex'], undefined);
    const serial = requests.length;
    let reply = replies[serial - 1] ?? 'invalid';
    if (options.nativeDelegate) {
      if (serial === 1) {
        reply =
          'SPAWN:' +
          JSON.stringify({
            agent_type: 'scout',
            message: 'Inspect the current project.',
          });
      } else if (body.includes('RSI_CHILD_INSTRUCTIONS')) {
        reply = '{"answer":"child inspected"}';
        childStarted();
      } else {
        await child;
        reply = '{"answer":"ok"}';
      }
    }
    if (reply === 'WAIT') return;
    if (reply === 'CANCEL') {
      controller.abort(new Error('Test cancelled'));
      return;
    }
    if (reply === 'HTTP500') {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":{"message":"Temporary failure"}}');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events(reply, serial));
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing local address');
  const config = {
    auditDirectory: directory,
    model: 'configured-model',
    model_provider: 'local',
    model_reasoning_effort: 'low',
    requestMaxRetries: options.retries ?? 0,
    approvalRequired: options.approvalRequired ?? false,
    rpcError: options.rpcError ?? false,
    turnFailure: options.turnFailure ?? false,
    systemInstructions: 'PERSONAL_SYSTEM_MARKER',
    developerInstructions: 'PERSONAL_DEVELOPER_MARKER',
    model_providers: {
      local: { base_url: `http://127.0.0.1:${address.port}/v1` },
    },
  };
  await writeFile(join(home, 'fixture.json'), JSON.stringify(config));
  await writeFile(join(home, 'instructions.md'), config.systemInstructions);
  await writeFile(
    join(home, 'config.toml'),
    [
      'model="configured-model"',
      'model_provider="local"',
      'model_reasoning_effort="low"',
      `model_instructions_file=${JSON.stringify(join(home, 'instructions.md'))}`,
      'developer_instructions="PERSONAL_DEVELOPER_MARKER"',
      '[model_providers.local]',
      'name="Local fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`,
      'env_key="RSI_CODEX_TEST_KEY"',
      'wire_api="responses"',
      'supports_websockets=false',
      `request_max_retries=${options.retries ?? 0}`,
      'stream_max_retries=0',
    ].join('\n'),
  );
  const executable = join(directory, 'codex.cjs');
  await writeFile(
    executable,
    await readFile(resolve('tests/fixtures/codex-cli.cjs')),
  );
  const previous = {
    home: process.env.CODEX_HOME,
    key: process.env.RSI_CODEX_TEST_KEY,
  };
  process.env.CODEX_HOME = home;
  process.env.RSI_CODEX_TEST_KEY = 'test-key';
  const context = new RuntimeContext().extend({
    directory,
    signal: controller.signal,
    async charge() {
      throw new Error('Must not invent or intercept native modelCalls');
    },
  });
  const operation = await createAgentCodex(
    {
      executable: process.env.RSI_TEST_CODEX_EXECUTABLE ?? executable,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: options.thinkingLevel }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    },
    context,
  );
  return {
    directory,
    requests,
    cwd,
    run: (role?: string) =>
      operation.execute(
        {
          cwd,
          goal: 'Read authorized evidence',
          outputSchema: options.outputSchema ?? schema,
          ...(role === undefined ? {} : { role }),
        },
        context,
      ),
    async changeModel(model: string) {
      config.model = model;
      await writeFile(join(home, 'fixture.json'), JSON.stringify(config));
      const path = join(home, 'config.toml');
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(
          'model="configured-model"',
          `model=${JSON.stringify(model)}`,
        ),
      );
    },
    async close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await operation.dispose();
      if (previous.home === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.home;
      if (previous.key === undefined) delete process.env.RSI_CODEX_TEST_KEY;
      else process.env.RSI_CODEX_TEST_KEY = previous.key;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Codex uses the managed project cwd and the native tool surface', async (t) => {
  const native = Boolean(process.env.RSI_TEST_CODEX_EXECUTABLE);
  const f = await fixture(
    ['{"answer":"ok"}'],
    native ? { nativeDelegate: true, timeoutMs: 8000 } : {},
  );
  t.after(() => f.close());
  const project = f.cwd;
  await mkdir(join(project, '.codex', 'agents'), { recursive: true });
  await writeFile(
    join(project, '.codex/agents/scout.toml'),
    'name = "scout"\ndescription = "RSI_SCOUT_ROLE"\ndeveloper_instructions = "RSI_CHILD_INSTRUCTIONS"\n',
  );
  assert.deepEqual(await f.run(), { answer: 'ok' });
  if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
    const audit = object(
      JSON.parse(await readFile(join(f.directory, 'execution.json'), 'utf8')),
    );
    assert.equal(object(audit.thread).cwd, await realpath(project));
    assert.equal(object(audit.turn).cwd, await realpath(project));
    assert.equal(object(audit.thread).dynamicTools, undefined);
    assert.equal(object(audit.thread).ephemeral, false);
    assert.match(JSON.stringify(audit.args), /project_root_markers/);
    assert.match(String(object(audit.thread).permissions), /^rsi-agent-/);
    assert.match(JSON.stringify(audit.args), /workspace_roots/);
  } else {
    assert.match(JSON.stringify(f.requests[0]), /PROJECT_INSTRUCTIONS/);
    const childRequest = f.requests.find((request) =>
      JSON.stringify(request).includes('RSI_CHILD_INSTRUCTIONS'),
    );
    assert.ok(childRequest);
    assert.match(JSON.stringify(childRequest), /PROJECT_INSTRUCTIONS/);
    const tools = f.requests[0]!.tools as JsonObject[];
    assert.ok(
      JSON.stringify(tools).includes('RSI_SCOUT_ROLE'),
      tools.map((tool) => [tool.type, tool.name]).join(' '),
    );
  }
});

test('Codex config defaults and validation follow its schema', async () => {
  assert.deepEqual(parseConfig(configSchema, {}, 'config'), {
    executable: 'codex',
  });
  for (const config of [
    { model: '' },
    { model: ' ' },
    { thinkingLevel: ' ' },
    { timeoutMs: 0 },
    { unknownOption: true },
  ])
    await assert.rejects(
      createAgentCodex(config, new RuntimeContext()),
      /agent.codex config/,
    );
});
for (const model of [undefined, 'selected-model'])
  test(`Codex uses ${model ?? 'the local default model'} without changing local settings`, async () => {
    const f = await fixture(['{"answer":"ok"}'], { model });
    try {
      assert.deepEqual(await f.run(), { answer: 'ok' });
      assert.equal(f.requests[0].model, model ?? 'configured-model');
      const diagnostics = await readFile(
        join(f.directory, 'diagnostics.jsonl'),
        'utf8',
      );
      assert.ok(diagnostics.includes('"modelCalls":"unavailable"'));
      assert.ok(!diagnostics.includes('test-key'));
      if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
        const x = JSON.parse(
          await readFile(join(f.directory, 'execution.json'), 'utf8'),
        );
        assert.equal(x.args.at(-1), 'app-server');
        assert.equal(x.dir, await realpath(f.cwd));
        const tokenUsage = diagnostics
          .trim()
          .split('\n')
          .map((line) => object(JSON.parse(line)))
          .find((event) => event.type === 'token_usage');
        assert.ok(tokenUsage);
        assert.equal(object(object(tokenUsage.data).total).totalTokens, 13);
        for (const name of [
          'baseInstructions',
          'developerInstructions',
          'approvalPolicy',
          'sandbox',
        ])
          assert.equal(Object.hasOwn(x.thread, name), false);
        assert.deepEqual(x.turn.outputSchema, schema);
      }
    } finally {
      await f.close();
    }
  });
test('Codex forwards the production edit schema unchanged and accepts all edit operations', async () => {
  const reply = {
    edits: [
      {
        op: 'patch',
        path: 'existing.md',
        changes: [{ oldText: 'old', newText: 'new' }],
      },
      { op: 'create', path: 'new.md', content: 'New guidance' },
      { op: 'replace', path: 'instructions.md', content: 'Updated guidance' },
      { op: 'delete', path: 'obsolete.md' },
    ],
    reason: 'Update guidance',
  };
  const original = structuredClone(proposerEditOutputSchema);
  const f = await fixture([JSON.stringify(reply)], {
    outputSchema: object(proposerEditOutputSchema),
  });
  try {
    assert.deepEqual(await f.run(), reply);
    if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
      const execution = JSON.parse(
        await readFile(join(f.directory, 'execution.json'), 'utf8'),
      );
      assert.deepEqual(execution.turn.outputSchema, proposerEditOutputSchema);
      const items = execution.turn.outputSchema.properties.edits.items;
      assert.equal(items.oneOf, undefined);
      assert.equal(items.anyOf.length, 4);
    }
    assert.deepEqual(proposerEditOutputSchema, original);
  } finally {
    await f.close();
  }
});

test('Codex preserves native personal instructions, provider requests and tools', async () => {
  const f = await fixture(['{"answer":"ok"}']);
  try {
    await f.run();
    const body = JSON.stringify(f.requests[0]);
    assert.ok(body.includes('PERSONAL_SYSTEM_MARKER'));
    assert.ok(body.includes('PERSONAL_DEVELOPER_MARKER'));
    assert.ok(
      (f.requests[0].tools as { name: string }[]).some(
        (t) => t.name === 'exec_command',
      ),
    );
  } finally {
    await f.close();
  }
});
test('Codex overrides local reasoning effort for the session', async () => {
  const f = await fixture(['{"answer":"ok"}'], { thinkingLevel: 'medium' });
  try {
    assert.deepEqual(await f.run(), { answer: 'ok' });
    assert.deepEqual(f.requests[0].reasoning, { effort: 'medium' });
  } finally {
    await f.close();
  }
});

test('Codex native provider retries are not disabled or latched by RSI', async () => {
  const f = await fixture(['HTTP500', '{"answer":"ok"}'], { retries: 1 });
  try {
    assert.deepEqual(await f.run(), { answer: 'ok' });
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});
test('Codex accepts local model changes between executions without a configuration lock', async () => {
  const f = await fixture(['{"answer":"ok"}', '{"answer":"ok"}']);
  try {
    await f.run();
    await f.changeModel('changed-model');
    await f.run();
    assert.deepEqual(
      f.requests.map((r) => r.model),
      ['configured-model', 'changed-model'],
    );
  } finally {
    await f.close();
  }
});
test('Codex validates the final JSON without a separate RSI correction loop', async () => {
  const f = await fixture(['{"answer":3}', '{"answer":"ok"}']);
  try {
    await assert.rejects(f.run(), /agent output/);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
for (const scenario of [
  {
    name: 'cancellation',
    reply: 'CANCEL',
    timeoutMs: undefined,
    error: /Test cancelled/,
  },
  {
    name: 'explicit timeout',
    reply: 'WAIT',
    timeoutMs: 5000,
    error: /timed out/,
  },
])
  test(`Codex propagates ${scenario.name} and preserves the caller's project`, async () => {
    const f = await fixture([scenario.reply], {
      timeoutMs: scenario.timeoutMs,
    });
    try {
      await assert.rejects(f.run(), scenario.error);
      assert.equal(
        await readFile(join(f.cwd, 'AGENTS.md'), 'utf8'),
        'PROJECT_INSTRUCTIONS',
      );
      if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
        const audit = JSON.parse(
          await readFile(join(f.directory, 'execution.json'), 'utf8'),
        );
        assert.throws(() => process.kill(audit.pid, 0), { code: 'ESRCH' });
      }
    } finally {
      await f.close();
    }
  });
test('Codex surfaces interactive approval requests without silently approving or overriding policy', async () => {
  const f = await fixture([], { approvalRequired: true });
  try {
    await assert.rejects(f.run(), /interactive input or approval/);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});
for (const scenario of [
  { options: { rpcError: true }, error: /Model unavailable.*-32602/ },
  { options: { turnFailure: true }, error: /Authentication expired/ },
])
  test(`Codex preserves native failure details ${JSON.stringify(scenario.options)}`, async () => {
    const f = await fixture([], scenario.options);
    try {
      await assert.rejects(f.run(), scenario.error);
      assert.equal(f.requests.length, 0);
    } finally {
      await f.close();
    }
  });
test('existing Policy accepts the native Codex binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-recipe-'));
  const runtime = await createRuntime({
    rootDirectory: directory,
    homeDirectory: false,
  });
  try {
    const recipe = await Recipe.load(
      resolve('examples/harness/dsh-wikiskill/recipe.yaml'),
      runtime.registry,
    );
    const declaration = recipe.toJSON();
    object(declaration.bindings).agent = { plugin: 'agent.codex', config: {} };
    const path = join(directory, 'recipe.yaml');
    await writeFile(path, stringify(declaration));
    assert.equal(
      (await Recipe.load(path, runtime.registry)).bindings.agent?.pluginId,
      'agent.codex',
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex keeps calls without roles ephemeral and inherits native search settings', async () => {
  const f = await fixture(['{"answer":"ok"}']);
  try {
    await f.run();
    if (!process.env.RSI_TEST_CODEX_EXECUTABLE) {
      const audit = object(
        JSON.parse(await readFile(join(f.directory, 'execution.json'), 'utf8')),
      );
      assert.equal(object(audit.thread).ephemeral, true);
      assert.ok(
        Array.isArray(audit.args) &&
          !audit.args.some(
            (arg: unknown) =>
              typeof arg === 'string' && arg.startsWith('web_search='),
          ),
      );
    }
  } finally {
    await f.close();
  }
});
