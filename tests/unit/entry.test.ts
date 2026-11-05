import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileFacts, FileArtifacts } from '../../src/runtime/storage/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/entries/web/server.js';
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
