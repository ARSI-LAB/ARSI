import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../../web/vite.config.js';

test('the development proxy forwards HTTP API routes while Vite serves API client source modules', () => {
  const proxy = config.server?.proxy ?? {};
  const matches = (path: string): boolean =>
    Object.keys(proxy).some((key) =>
      key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key),
    );
  for (const path of [
    '/api/catalog',
    '/api/experiments',
    '/api/observation/experiments/example',
    '/api/observation/experiments/example/artifacts/file.ts',
  ])
    assert.equal(matches(path), true, path);
  for (const path of [
    '/api/observation-client.ts',
    '/api/connection-state.ts?v=version',
    '/api/query-cache.js',
    '/api/client.mts',
    '/app/app.tsx',
    '/apiculture',
  ])
    assert.equal(matches(path), false, path);
});
