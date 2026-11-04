const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const config = JSON.parse(
  fs.readFileSync(path.join(process.env.CODEX_HOME, 'fixture.json'), 'utf8'),
);
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli fixture-1\n');
} else {
  const args = process.argv.slice(2);
  const overrides = Object.fromEntries(
    args.flatMap((value, i) => {
      if (args[i - 1] !== '-c') return [];
      const eq = value.indexOf('=');
      return [[value.slice(0, eq), value.slice(eq + 1)]];
    }),
  );
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  let input = '';
  let pendingTool;
  const rl = readline.createInterface({ input: process.stdin });
  const generate = async () => {
    const key =
      'model_providers.' +
      (config.model_provider === 'openai'
        ? 'rsi-local-openai'
        : config.model_provider);
    const headers = {
      authorization: 'Bearer ' + process.env.RSI_CODEX_TEST_KEY,
      'X-RSI-Codex': JSON.parse(overrides[key + '.http_headers.X-RSI-Codex']),
    };
    if (config.auditChatgpt) headers['chatgpt-account-id'] = 'test-account';
    const response = await fetch(
      JSON.parse(overrides[key + '.base_url']) + '/responses',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: overrides.model ? JSON.parse(overrides.model) : config.model,
          input,
          instructions: fs.readFileSync(
            JSON.parse(overrides.model_instructions_file),
            'utf8',
          ),
          reasoning: { effort: config.model_reasoning_effort },
          tools: [{ type: 'function', name: 'exec_command' }],
        }),
      },
    );
    if (!response.ok) process.exit(1);
    const events = (await response.text())
      .split('\n')
      .filter((x) => x.startsWith('data: '))
      .map((x) => JSON.parse(x.slice(6)));
    const item = events.find((x) => x.type === 'response.completed').response
      .output[0];
    if (item.type === 'function_call') {
      pendingTool = item.call_id;
      send({
        id: pendingTool,
        method: 'item/tool/call',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          tool: item.name,
          arguments: JSON.parse(item.arguments),
        },
      });
    } else {
      send({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            text: item.content[0].text,
            phase: 'final_answer',
          },
        },
      });
      send({
        method: 'turn/completed',
        params: { turn: { status: 'completed' } },
      });
    }
  };
  rl.on('line', (line) => {
    const request = JSON.parse(line);
    (async () => {
      if (request.method === 'initialize') send({ id: request.id, result: {} });
      else if (request.method === 'config/read')
        send({ id: request.id, result: { config } });
      else if (request.method === 'thread/start') {
        fs.writeFileSync(
          path.join(config.auditDirectory, 'execution.json'),
          JSON.stringify({
            dir: process.cwd(),
            home: process.env.CODEX_HOME,
            args,
            params: request.params,
          }),
        );
        send({
          id: request.id,
          result: {
            thread: { id: 'thread' },
            model: overrides.model ? JSON.parse(overrides.model) : config.model,
            reasoningEffort: config.model_reasoning_effort,
            serviceTier: null,
          },
        });
      } else if (request.method === 'turn/start') {
        input += '\n' + request.params.input[0].text;
        send({ id: request.id, result: {} });
        await generate();
      } else if (pendingTool && request.id === pendingTool) {
        input += '\n' + JSON.stringify(request.result);
        await generate();
      }
    })().catch(() => process.exit(1));
  });
}
