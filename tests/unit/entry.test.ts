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
      'agent.codex',
      'agent.pi',
      'application.agentbundle',
      'application.inference',
      'application.kernel',
      'evaluator.agentbench',
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
    ]);
    assert.deepEqual(catalog.policies.sort(), [
      'parameter.agent',
      'policy.gepa',
      'policy.harness2',
      'policy.operator-search',
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
      cancel: async () => {},
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
