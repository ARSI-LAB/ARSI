const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const config = JSON.parse(
  fs.readFileSync(path.join(process.env.CODEX_HOME, 'fixture.json'), 'utf8'),
);
const args = process.argv.slice(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const history = [];
let model = config.model;
let pendingTool;
let nextToolId = 0;
let threadParams;
const generate = async () => {
  if (config.turnFailure) {
    send({
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: { message: 'Authentication expired' },
        },
      },
    });
    return;
  }
  if (config.approvalRequired) {
    send({
      id: nextToolId++,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn' },
    });
    return;
  }
  const provider = config.model_providers[config.model_provider];
  const headers = {
    authorization: 'Bearer ' + process.env.RSI_CODEX_TEST_KEY,
    'x-user-setting': 'preserved',
  };
  let response;
  for (let attempt = 0; attempt <= config.requestMaxRetries; attempt++) {
    response = await fetch(provider.base_url + '/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: history,
        instructions: config.systemInstructions,
        developer_instructions: config.developerInstructions,
        reasoning: { effort: config.model_reasoning_effort },
        tools: [
          ...threadParams.dynamicTools.map((t) => ({
            type: 'function',
            name: t.name,
            parameters: t.inputSchema,
          })),
          { type: 'function', name: 'exec_command' },
        ],
        stream: true,
        store: true,
      }),
    });
    if (response.ok || response.status < 500) break;
    await response.body.cancel();
  }
  if (!response.ok) {
    send({ method: 'turn/completed', params: { turn: { status: 'failed' } } });
    return;
  }
  const events = (await response.text())
    .split('\n')
    .filter((x) => x.startsWith('data: '))
    .map((x) => JSON.parse(x.slice(6)));
  const completed = events.find((x) => x.type === 'response.completed');
  if (!completed) {
    send({ method: 'turn/completed', params: { turn: { status: 'failed' } } });
    return;
  }
  const item = completed.response.output[0];
  if (item.type === 'function_call') {
    pendingTool = nextToolId++;
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
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  (async () => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    else if (request.method === 'thread/start') {
      if (config.rpcError) {
        send({
          id: request.id,
          error: { code: -32602, message: 'Model unavailable' },
        });
        return;
      }
      threadParams = request.params;
      model = threadParams.model ?? config.model;
      send({
        id: request.id,
        result: {
          thread: { id: 'thread' },
          model,
          modelProvider: config.model_provider,
          reasoningEffort: config.model_reasoning_effort,
        },
      });
    } else if (request.method === 'turn/start') {
      fs.writeFileSync(
        path.join(config.auditDirectory, 'execution.json'),
        JSON.stringify({
          dir: process.cwd(),
          home: process.env.CODEX_HOME,
          args,
          thread: threadParams,
          turn: request.params,
        }),
      );
      history.push(...request.params.input);
      send({ id: request.id, result: {} });
      await generate();
    } else if (pendingTool !== undefined && request.id === pendingTool) {
      history.push(request.result);
      await generate();
    }
  })().catch(() => process.exit(1));
});
