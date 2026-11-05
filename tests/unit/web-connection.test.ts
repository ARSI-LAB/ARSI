import test from 'node:test';
import assert from 'node:assert/strict';
import { readObservation } from '../../web/api/observation-client.js';
import {
  connectionError,
  connectionSnapshot,
  setDisconnected,
  subscribeConnection,
  subscribeRetry,
  retryConnection,
} from '../../web/api/connection-state.js';

test('network failures share one connection state, retry all subscribers and recover', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    setDisconnected(false);
  });
  let notifications = 0;
  const unsubscribe = subscribeConnection(() => notifications++);
  t.after(unsubscribe);
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    readObservation('/a', (value) => value),
    { message: connectionError },
  );
  await assert.rejects(
    readObservation('/b', (value) => value),
    { message: connectionError },
  );
  assert.equal(connectionSnapshot(), true);
  assert.equal(notifications, 1);
  let retries = 0;
  const first = subscribeRetry(() => retries++);
  const second = subscribeRetry(() => retries++);
  retryConnection();
  assert.equal(retries, 2);
  first();
  second();
  retryConnection();
  assert.equal(retries, 2);
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  await readObservation('/a', (value) => value);
  assert.equal(connectionSnapshot(), false);
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => {
    throw controller.signal.reason;
  };
  await assert.rejects(
    readObservation('/a', (value) => value, controller.signal),
  );
  assert.equal(connectionSnapshot(), false);
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(
    readObservation('/a', (value) => value),
    { message: connectionError },
  );
  assert.equal(connectionSnapshot(), true);
  globalThis.fetch = async () =>
    new Response('{"error":"Not found"}', { status: 404 });
  await assert.rejects(
    readObservation('/a', (value) => value),
    { message: 'Not found' },
  );
  assert.equal(connectionSnapshot(), false);
});
