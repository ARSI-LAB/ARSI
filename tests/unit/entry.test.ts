import { FileFacts, FileArtifacts } from '../../src/runtime/storage/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/entries/web/server.js';
import { createRuntime } from '../../src/runtime/context.js';

test('HTTP catalog exposes the registered kernel plugins and operator search Policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-entry-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: root });
  const server = await createServer(runtime);
  try {
    const response = await server.inject({ url: '/api/catalog' });
    assert.equal(response.statusCode, 200);
    const catalog = response.json();
    assert.deepEqual(catalog.plugins.sort(), [
      'agent.claudecode',
      'agent.codex',
      'agent.dsh',
      'agent.opencode',
      'agent.pi',
      'application.agentbundle',
      'application.inference',
      'application.kernel',
      'evaluator.agentbench',
      'evaluator.gym',
      'evaluator.inferencebench',
      'evaluator.operatorbench',
      'memory.agent',
      'proposer.agent',
      'proposer.grid',
      'proposer.operator',
      'proposer.optuna',
      'proposer.pareto-evolution',
      'reflection.agent',
      'selector.artifact',
      'selector.inference',
      'selector.metric',
      'summarizer.operator',
    ]);
    assert.deepEqual(catalog.policies.sort(), [
      'policy.gepa',
      'policy.gym-rsi',
      'policy.harness2',
      'policy.operator-search',
      'policy.parameter-agent',
      'policy.parameter-grid',
      'policy.parameter-optuna',
      'policy.wikiskill',
    ]);
  } finally {
    await server.close();
    await runtime.dispose();
  }
});

test('HTTP exposes catalog and rejects cross-origin mutation before dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let runs = 0;
  const server = await createServer({
    manager: {
      memory: () => {
        throw new Error('Unexpected Memory application');
      },
      reflection: () => {
        throw new Error('Unexpected reflection call');
      },
      facts: new FileFacts(join(directory, 'facts')),
      artifacts: new FileArtifacts(join(directory, 'artifacts')),
      list: async () => [],
      get: async (id) => ({ id, status: 'succeeded' }),
      run: async () => {
        runs++;
        return { status: 'succeeded' };
      },
      cancel: async () => {
        throw new Error('Experiment is not running');
      },
    },
    registry: {
      catalog: () => ({ plugins: ['agent.pi'], policies: ['policy.harness2'] }),
    },
  });
  try {
    const catalog = await server.inject({ url: '/api/catalog' });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().plugins, ['agent.pi']);
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/experiments',
      headers: { origin: 'https://untrusted.example' },
      payload: { recipePath: 'recipe.yaml' },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(runs, 0);
    const inactive = await server.inject({
      method: 'POST',
      url: '/api/experiments/stopped/cancel',
    });
    assert.equal(inactive.statusCode, 400);
    assert.deepEqual(inactive.json(), { error: 'Experiment is not running' });
    const unknown = await server.inject({
      method: 'POST',
      url: '/api/experiments',
      payload: { recipePath: 'recipe.yaml', unknown: 'field' },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(runs, 0);
    assert.equal(
      (
        await server.inject({
          method: 'POST',
          url: '/api/experiments',
          payload: { unknown: 'field' },
        })
      ).statusCode,
      400,
    );
  } finally {
    await server.close();
  }
});

test('public dashboard serves external reads and rejects every control before validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'arsi-public-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: root });
  t.after(() => runtime.dispose());
  const headers = {
    host: 'dashboard.example',
    origin: 'https://dashboard.example',
  };
  const local = await createServer(runtime);
  t.after(() => local.close());
  assert.equal(
    (await local.inject({ url: '/api/catalog', headers })).statusCode,
    403,
  );
  const server = await createServer(runtime, { publicReadOnly: true });
  t.after(() => server.close());
  for (const method of ['GET', 'HEAD'] as const) {
    assert.equal(
      (
        await server.inject({
          method,
          url: '/api/observation/experiments',
          headers,
        })
      ).statusCode,
      200,
    );
  }
  await runtime.manager.facts.write('experiments', 'demo', { id: 'demo' });
  await runtime.manager.facts.write('experiments', 'other', { id: 'other' });
  for (const [kind, collection, service] of [
    ['revisions', 'revisions', 'reflection'],
    ['memories', 'memory-revisions', 'memory'],
  ] as const) {
    await runtime.manager.facts.write(collection, 'version', {
      experimentId: 'demo',
    });
    t.mock.method(runtime.manager, service, () => {
      throw new Error('Public preview must not inspect local files');
    });
    const previewPath = (id: string) =>
      `/api/observation/experiments/${id}/${kind}/version/application?targetDir=export`;
    const preview = await server.inject({ url: previewPath('demo'), headers });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().applicationAllowed, false);
    assert.deepEqual(preview.json().changes, []);
    assert.equal(
      (await server.inject({ url: previewPath('other'), headers })).statusCode,
      404,
    );
  }
  for (const url of [
    '/api/experiments',
    '/api/experiments/demo/cancel',
    '/api/experiments/demo/revisions/version/apply',
    '/api/experiments/demo/memories/version/apply',
  ]) {
    const response = await server.inject({ method: 'POST', url, headers });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    assert.equal(
      (await server.inject({ method, url: '/api/experiments' })).statusCode,
      405,
    );
  }
});
