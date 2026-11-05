import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/entries/web/server.js';
import { seedLearning } from '../fixtures/learning/seed.js';
import {
  parseLearning,
  parseApplication,
  applyRevision,
} from '../../web/api/learning-client.js';

test('learning HTTP projects owned records, previews changes and applies through the existing boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-web-learning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await seedLearning(root);
  await f.facts.write('reflection', 'reflection-test', {
    experimentId: 'learning-run',
    reflectionId: 'reflection-test',
    stepPath: 'loop/3/renamed',
  });
  const revision = await f.facts.read('revisions', 'revision-next');
  await f.facts.write('revisions', 'revision-next', {
    ...revision,
    reflectionId: 'reflection-test',
  });
  await f.facts.write('calls', 'reflection-call', {
    experimentId: 'learning-run',
    callId: 'reflection-call',
    parentCallId: 'root',
    pluginId: 'reflection.agent',
    bindingId: '_reflection',
    path: 'reflection/reflection-test',
    status: 'succeeded',
  });
  const server = await createServer({
    manager: {
      ...f,
      reflection: () => f.application,
      list: () => f.facts.list('experiments'),
      get: (id) => f.facts.read('experiments', id),
      run: async () => {
        throw new Error('Unexpected run');
      },
      cancel: async () => {},
    },
    registry: { catalog: () => ({ plugins: [], policies: [] }) },
  });
  t.after(() => server.close());
  const base = '/api/observation/experiments/learning-run';
  const revisions = await server.inject(`${base}/revisions`);
  assert.equal(revisions.statusCode, 200);
  assert.equal(parseLearning(revisions.json()).length, 2);
  assert.equal(
    parseLearning(revisions.json()).find((r) => r.id === 'revision-next')?.path,
    'loop/3/renamed',
  );
  assert.equal(
    parseLearning(revisions.json()).find((r) => r.id === 'revision-initial')
      ?.path,
    null,
  );
  const calls = (await server.inject(`${base}/calls`)).json();
  assert.equal(
    calls.items.find((c: { callId: string }) => c.callId === 'reflection-call')
      .triggerPath,
    'loop/3/renamed',
  );
  assert.equal(
    (await server.inject(`${base}/calls/reflection-call`)).json().triggerPath,
    'loop/3/renamed',
  );
  assert.doesNotMatch(
    revisions.body,
    /learning-secret-value|base64|sourceResources/,
  );
  assert.match(revisions.body, /REDACTED/);
  const memories = parseLearning(
    (await server.inject(`${base}/memories`)).json(),
  );
  assert.equal(memories[0]?.parentRef, f.memoryBefore);
  for (const ref of [f.before, f.after, f.memoryBefore, f.memoryAfter])
    assert.equal(
      (await server.inject(`${base}/artifacts/${ref}`)).statusCode,
      200,
    );
  assert.equal(
    (
      await server.inject(
        `/api/observation/experiments/other-run/artifacts/${f.after}`,
      )
    ).statusCode,
    404,
  );
  const previewUrl = `${base}/revisions/revision-next/application`;
  const preview = parseApplication((await server.inject(previewUrl)).json());
  assert.equal(preview.applicationAllowed, true);
  assert.equal(preview.changes[0]?.action, 'replace');
  assert.equal(
    await readFile(join(f.guidance, 'checks.md'), 'utf8'),
    'Validate the output.\n',
  );
  const applyUrl =
    '/api/experiments/learning-run/revisions/revision-next/apply';
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: applyUrl,
        headers: { origin: 'https://foreign.example' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: applyUrl.replace('learning-run', 'other-run'),
      })
    ).statusCode,
    404,
  );
  await f.facts.write('experiments', 'active', {
    id: 'active',
    status: 'running',
  });
  const blocked = parseApplication((await server.inject(previewUrl)).json());
  assert.equal(blocked.applicationAllowed, false);
  assert.ok(blocked.restrictions.length);
  assert.equal(
    (await server.inject({ method: 'POST', url: applyUrl })).statusCode,
    400,
  );
  await f.facts.write('experiments', 'active', {
    id: 'active',
    status: 'succeeded',
  });
  assert.equal(
    (await server.inject({ method: 'POST', url: applyUrl })).json().status,
    'applied',
  );
  assert.match(
    await readFile(join(f.guidance, 'checks.md'), 'utf8'),
    /verify formula results/,
  );
  assert.equal(
    (await server.inject({ method: 'POST', url: applyUrl })).json().status,
    'unchanged',
  );
});

test('application client never retries a failed write and rejects invalid responses', async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      calls++;
      assert.equal(init.method, 'POST');
      throw new Error('Connection lost');
    },
  );
  await assert.rejects(applyRevision('run', 'revision'), /Connection lost/);
  assert.equal(calls, 1);
  assert.throws(() =>
    parseApplication({
      applicationAllowed: 'yes',
      restrictions: [],
      changes: [],
    }),
  );
  assert.throws(() => parseLearning([{ id: 42 }]));
});
