import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/entries/web/server.js';
import { seedLearning } from '../fixtures/learning/seed.js';
import {
  parseLearning,
  parseApplication,
  applySnapshot,
} from '../../web/api/learning-client.js';

test('learning HTTP projects owned records, previews changes and applies through the existing boundary', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'rsi-web-learning-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await seedLearning(root);
  await f.facts.write('learning-runs', 'reflection-test', {
    experimentId: 'learning-run',
    learningId: 'reflection-test',
    kind: 'reflection',
    triggerPath: 'loop/3/renamed',
    callId: 'reflection-call',
  });
  const revision = await f.facts.read('revisions', 'revision-next');
  await f.facts.write('revisions', 'revision-next', {
    ...revision,
    learningId: 'reflection-test',
  });
  await f.facts.write('calls', 'reflection-call', {
    experimentId: 'learning-run',
    callId: 'reflection-call',
    parentCallId: 'root',
    pluginId: 'reflection.agent',
    bindingId: '_reflection',
    path: 'learning/reflection-test',
    status: 'succeeded',
  });
  const server = await createServer({
    manager: {
      ...f,
      reflection: () => f.application,
      memory: () => f.memoryApplication,
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
  const chain = parseLearning(revisions.json());
  assert.deepEqual(
    chain.map((r) => [r.id, r.depth]),
    [
      ['revision-next', 1],
      ['revision-initial', 0],
    ],
  );
  assert.deepEqual(chain[0]?.changedBindings, ['proposer', 'summarizer']);
  assert.deepEqual(chain[1]?.bindings, ['proposer', 'summarizer']);
  assert.equal(chain[0]?.binding, null);
  await f.facts.write('revisions', 'legacy-revision', {
    experimentId: 'other-run',
    ref: 'legacy-revision',
    parentRef: null,
    kind: 'initial',
    binding: 'worker',
  });
  const legacy = parseLearning(
    (
      await server.inject('/api/observation/experiments/other-run/revisions')
    ).json(),
  );
  assert.equal(legacy[0]?.binding, 'worker');
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
  const attemptStatuses = [
    ['started', true],
    ['evidence-prepared', true],
    ['prepared', true],
    ['validated', true],
    ['no-change', false],
    ['rejected', false],
    ['skipped', false],
  ] as const;
  for (const [status] of attemptStatuses)
    await f.facts.write('learning-runs', status, {
      experimentId: 'learning-run',
      learningId: status,
      kind: 'memory',
      status,
    });
  const memories = parseLearning(
    (await server.inject(`${base}/memories`)).json(),
  );
  for (const [status, inProgress] of attemptStatuses)
    assert.equal(
      memories.find((record) => record.id === status)?.inProgress,
      inProgress,
      status,
    );
  const memory = memories.find((record) => record.id === 'memory-next');
  assert.equal(memory?.parentRef, 'memory-initial');
  assert.equal(memory?.parentArtifactRef, f.memoryBefore);
  assert.equal(memory?.callId, 'memory-update');
  const application = `${base}/memories/memory-next/application`;
  assert.match(
    (await server.inject(application)).body,
    /Choose a dedicated export directory/,
  );
  const to = join(root, 'export');
  assert.equal(
    parseApplication(
      (
        await server.inject(
          application + '?' + new URLSearchParams({ targetDir: to }),
        )
      ).json(),
    ).applicationAllowed,
    true,
  );
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: '/api/experiments/other-run/memories/memory-next/apply',
        payload: { targetDir: to },
      })
    ).statusCode,
    404,
  );
  const applied = await server.inject({
    method: 'POST',
    url: '/api/experiments/learning-run/memories/memory-next/apply',
    payload: { targetDir: to },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().status, 'applied');
  assert.match(
    await readFile(join(to, 'experience.md'), 'utf8'),
    /Check formula results/,
  );
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
  const targetDir = join(root, 'exported-revision');
  const exportPreview = parseApplication(
    (
      await server.inject(previewUrl + '?' + new URLSearchParams({ targetDir }))
    ).json(),
  );
  assert.deepEqual(exportPreview.destinations, [targetDir]);
  assert.equal(exportPreview.applicationAllowed, true);
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: applyUrl,
        payload: { targetDir },
      })
    ).json().status,
    'applied',
  );
  assert.match(
    await readFile(join(targetDir, 'checks.md'), 'utf8'),
    /verify formula results/,
  );
  assert.equal(
    await readFile(join(f.guidance, 'checks.md'), 'utf8'),
    'Validate the output.\n',
  );
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: applyUrl,
        payload: { targetDir: f.directory },
      })
    ).statusCode,
    400,
  );
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
  const initialPreview = parseApplication(
    (
      await server.inject(`${base}/revisions/revision-initial/application`)
    ).json(),
  );
  assert.equal(initialPreview.applicationAllowed, true);
  assert.deepEqual(initialPreview.destinations, [f.guidance]);
  assert.equal(initialPreview.changes[0]?.action, 'replace');
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: '/api/experiments/learning-run/revisions/revision-initial/apply',
      })
    ).json().status,
    'applied',
  );
  assert.equal(
    await readFile(join(f.guidance, 'checks.md'), 'utf8'),
    'Validate the output.\n',
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
  await assert.rejects(
    applySnapshot('run', 'revisions', 'revision'),
    /Connection lost/,
  );
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
