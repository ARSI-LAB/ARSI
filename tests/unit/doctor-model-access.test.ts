import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { probeModelAccess } from '../../src/runtime/doctor/model-access.js';
import type { ModelAccessInput } from '../../src/runtime/doctor/model-access.js';

async function serve(
  t: test.TestContext,
  listener: RequestListener,
): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}/v1`;
}

function input(baseUrl: string): ModelAccessInput {
  return {
    side: 'Proposal',
    model: 'fixture-model',
    baseUrl,
    apiKey: 'proposal-fixture-secret',
  };
}

test('model access uses each side own key and only requests its model list', async (t) => {
  const requests: {
    method: string | undefined;
    path: string | undefined;
    key: string | undefined;
  }[] = [];
  const baseUrl = await serve(t, (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      key: request.headers.authorization,
    });
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  const proposal = await probeModelAccess(input(`${baseUrl}/`));
  const evaluation = await probeModelAccess({
    ...input(baseUrl),
    side: 'Evaluation',
    apiKey: 'evaluation-fixture-secret',
  });
  assert.equal(proposal.status, 'passed');
  assert.equal(evaluation.status, 'passed');
  assert.match(proposal.reason, /^Proposal connected.*fixture-model/);
  assert.match(evaluation.reason, /^Evaluation connected.*fixture-model/);
  assert.deepEqual(requests, [
    {
      method: 'GET',
      path: '/v1/models',
      key: 'Bearer proposal-fixture-secret',
    },
    {
      method: 'GET',
      path: '/v1/models',
      key: 'Bearer evaluation-fixture-secret',
    },
  ]);
  assert.equal(proposal.details.httpStatus, 200);
  assert.equal(proposal.details.modelCount, 1);
  assert.doesNotMatch(JSON.stringify([proposal, evaluation]), /fixture-secret/);
});

test('model access requires HTTP 200 even if another status includes a model list', async (t) => {
  const baseUrl = await serve(t, (_request, response) => {
    response.statusCode = 201;
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  const result = await probeModelAccess(input(baseUrl));
  assert.equal(result.status, 'failed');
  assert.equal(result.details.failure, 'http-status');
  assert.equal(result.details.httpStatus, 201);
  assert.match(result.reason, /HTTP 201.*base_url/);
});

for (const status of [401, 403]) {
  test(`model access explains HTTP ${status} without echoing service errors or keys`, async (t) => {
    const baseUrl = await serve(t, (_request, response) => {
      response.statusCode = status;
      response.end('sensitive-response proposal-fixture-secret');
    });
    const result = await probeModelAccess({
      ...input(baseUrl),
      side: 'Evaluation',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.details.failure, 'access-denied');
    assert.equal(result.details.httpStatus, status);
    assert.match(
      result.reason,
      /^Evaluation.*denied.*evaluation API key and permissions/,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /sensitive-response|fixture-secret/,
    );
  });
}

test('model access distinguishes invalid JSON, invalid lists and an absent model', async (t) => {
  const bodies = [
    'not JSON',
    '{}',
    JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 7 }] }),
    JSON.stringify({ data: [{ id: 'fixture-model' }, { id: '   ' }] }),
    JSON.stringify({ data: [{ id: 'fixture-model' }, null] }),
    JSON.stringify({ data: [] }),
    JSON.stringify({ data: [{ id: 'another-model' }] }),
  ];
  const baseUrl = await serve(t, (_request, response) =>
    response.end(bodies.shift()),
  );
  const results = [];
  for (let index = 0; index < 7; index++) {
    results.push(await probeModelAccess(input(baseUrl)));
  }
  assert.deepEqual(
    results.map((result) => result.details.failure),
    [
      'invalid-json',
      'invalid-model-list',
      'invalid-model-list',
      'invalid-model-list',
      'invalid-model-list',
      'model-absent',
      'model-absent',
    ],
  );
  assert.ok(results.every((result) => result.status === 'failed'));
  assert.match(results[0].reason, /invalid JSON.*base_url/);
  assert.match(results[1].reason, /invalid model list.*data\[\]\.id/);
  assert.match(
    results[6].reason,
    /did not contain "fixture-model".*model name/,
  );
});

test('model access bounds response reading and keeps partial HTTP facts on timeout', async (t) => {
  const baseUrl = await serve(t, (_request, response) => {
    response.writeHead(200);
    response.write('{"data":');
  });
  const result = await probeModelAccess({ ...input(baseUrl), timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.details.failure, 'timeout');
  assert.equal(result.details.httpStatus, 200);
  assert.match(
    result.reason,
    /timed out.*base_url.*execution environment network/,
  );
});

test('model access propagates caller cancellation instead of reporting a service failure', async (t) => {
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  const baseUrl = await serve(t, (_request, response) => {
    response.writeHead(200);
    response.write('{');
    controller.abort(reason);
  });
  await assert.rejects(
    probeModelAccess(input(baseUrl), controller.signal),
    (error) => error === reason,
  );
});

test('model access distinguishes network failure without exposing URL or key values', async (t) => {
  const baseUrl = await serve(t, (request) => request.socket.destroy());
  const result = await probeModelAccess(input(baseUrl));
  assert.equal(result.status, 'failed');
  assert.equal(result.details.failure, 'network');
  assert.match(
    result.reason,
    /could not reach.*base_url.*execution environment network/,
  );
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|fixture-secret/);
});

test('model access refuses redirects without forwarding credentials', async (t) => {
  let redirectedRequests = 0;
  const target = await serve(t, (_request, response) => {
    redirectedRequests++;
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  const baseUrl = await serve(t, (_request, response) => {
    response.writeHead(302, { location: `${target}/models` });
    response.end();
  });
  const result = await probeModelAccess(input(baseUrl));
  assert.equal(result.status, 'failed');
  assert.equal(redirectedRequests, 0);
});

test('model access caps response bytes and discards untrusted response content', async (t) => {
  const baseUrl = await serve(t, (_request, response) => {
    response.end(`sensitive-response${'x'.repeat(1024 * 1024)}`);
  });
  const result = await probeModelAccess(input(baseUrl));
  assert.equal(result.status, 'failed');
  assert.equal(result.details.failure, 'response-too-large');
  assert.match(result.reason, /1 MiB.*base_url/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /sensitive-response|fixture-secret/,
  );
});

test('model access rejects credential-bearing service URLs without echoing them', async () => {
  const result = await probeModelAccess(
    input('http://fixture:password@localhost/v1'),
  );
  assert.equal(result.details.failure, 'invalid-url');
  assert.match(result.reason, /invalid.*base_url/);
  assert.doesNotMatch(JSON.stringify(result), /password|localhost/);
});
