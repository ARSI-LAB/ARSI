import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { runGepa } from '../fixtures/gepa-runtime.js';

function sseChunk(delta: object, finish: string | null): string {
  return (
    'data: ' +
    JSON.stringify({
      id: 'local-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    '\n\n'
  );
}
async function localModel(onRequest?: (count: number) => void) {
  let requests = 0;
  const seenTools = new Map<string, string>();
  let sockets = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const piece of req) body += String(piece);
    const request = JSON.parse(body);
    requests++;
    onRequest?.(requests);
    for (const message of request.messages ?? [])
      if (message.role === 'tool')
        seenTools.set(message.tool_call_id, String(message.content));
    const toolUse = requests <= 4;
    const delta = toolUse
      ? {
          role: 'assistant',
          tool_calls: [0, 1].map((index) => ({
            index,
            id: 'read-' + requests + '-' + index,
            type: 'function',
            function: {
              name: 'read',
              arguments: JSON.stringify({
                path: 'candidate/a.md',
                offset: 1,
                limit: 1,
              }),
            },
          })),
        }
      : {
          role: 'assistant',
          content: JSON.stringify({
            edits: [{ path: 'a.md', content: 'A1' }],
            reason:
              'Completed four tool turns, eight authorized page reads, then final schema-valid JSON.',
          }),
        };
    if (onRequest && requests === 2) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sseChunk(delta, null) +
        sseChunk({}, toolUse ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  });
  server.on('connection', (socket) => {
    sockets++;
    socket.on('close', () => sockets--);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture port unavailable');
  return {
    endpoint: 'http://127.0.0.1:' + address.port + '/v1',
    get requests() {
      return requests;
    },
    seenTools,
    get sockets() {
      return sockets;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
const common = {
  seed: 11,
  maxRounds: 1,
  maxRollouts: 20,
  feedbackTasks: ['task-a'],
  selectionTasks: ['task-a'],
  scoreTable: {
    'A0|B0': { scores: { 'task-a': 0.2 } },
    'A1|B0': { scores: { 'task-a': 0.9 } },
  },
  proposals: { a: 'A1' },
};
test('actual Pi reads managed candidate files and respects the Manager model-call budget', async () => {
  const previous = process.env.GEPA_LOCAL_FIXTURE_KEY;
  process.env.GEPA_LOCAL_FIXTURE_KEY = 'localhost-fixture-only';
  const evidence: JsonObject[] = [];
  try {
    for (const cap of [4, 12]) {
      const model = await localModel();
      let run: Awaited<ReturnType<typeof runGepa>> | undefined;
      try {
        if (cap === 4) {
          let terminal: JsonObject | undefined;
          let evaluations = -1;
          await assert.rejects(
            runGepa({
              ...common,
              modelCallBudget: cap,
              realAgentEndpoint: model.endpoint,
              onFailure: async (snapshot, calls) => {
                terminal = snapshot;
                evaluations = calls.evaluationCalls.length;
              },
            }),
            /modelCalls/i,
          );
          assert.equal(terminal?.status, 'failed');
          assert.equal(evaluations, 2);
          assert.equal(model.requests, 4);
        } else {
          run = await runGepa({
            ...common,
            modelCallBudget: cap,
            realAgentEndpoint: model.endpoint,
          });
          const rounds = run.output.rounds as JsonObject[];
          assert.equal(run.output.completedRounds, 1);
          assert.equal(rounds[0]!.status, 'admitted');
          assert.equal(model.requests, 5);
          assert.equal(model.seenTools.size, 8);
          assert.ok(
            [...model.seenTools.values()].every(
              (value) => value.includes('A0') && !value.includes('error'),
            ),
          );
        }
        evidence.push({
          cap,
          requests: model.requests,
          observedReadResults: model.seenTools.size,
          completedRounds: run?.output.completedRounds ?? null,
          status: run ? 'succeeded' : 'failed',
        });
      } finally {
        if (run) {
          await run.manager.dispose();
          await rm(run.root, { recursive: true, force: true });
        }
        await model.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GEPA_LOCAL_FIXTURE_KEY;
    else process.env.GEPA_LOCAL_FIXTURE_KEY = previous;
  }
  console.log('LOCAL_PI_PROOF ' + JSON.stringify(evidence));
});
test('actual public Manager cancellation terminates in-flight Pi and starts no candidate evaluation', async () => {
  const previous = process.env.GEPA_LOCAL_FIXTURE_KEY;
  process.env.GEPA_LOCAL_FIXTURE_KEY = 'localhost-fixture-only';
  const controller = new AbortController();
  let failed: JsonObject | undefined;
  const model = await localModel((count) => {
    if (count === 2)
      setTimeout(
        () => controller.abort(new Error('controlled-cancellation')),
        20,
      );
  });
  try {
    await assert.rejects(
      runGepa({
        ...common,
        modelCallBudget: 12,
        realAgentEndpoint: model.endpoint,
        signal: controller.signal,
        onFailure: async (snapshot) => {
          failed = snapshot;
        },
      }),
      /controlled-cancellation|abort/i,
    );
    assert.equal(failed?.status, 'cancelled');
    assert.equal(model.requests, 2);
    console.log(
      'LOCAL_CANCEL_PROOF ' +
        JSON.stringify({ status: failed?.status, requests: model.requests }),
    );
  } finally {
    await model.close();
    if (previous === undefined) delete process.env.GEPA_LOCAL_FIXTURE_KEY;
    else process.env.GEPA_LOCAL_FIXTURE_KEY = previous;
  }
});
