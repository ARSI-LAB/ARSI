import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryCache } from '../../web/api/query-cache.js';

test('query cache reuses fresh data, isolates keys, and refreshes explicitly', async () => {
  const cache = new QueryCache<number>();
  let reads = 0;
  const load = async () => ++reads;
  const signal = new AbortController().signal;
  assert.equal(await cache.read('one', load, signal, 15000), 1);
  assert.equal(cache.peek('one'), 1);
  assert.equal(await cache.read('one', load, signal, 15000), 1);
  assert.equal(await cache.read('two', load, signal, 15000), 2);
  assert.equal(await cache.read('one', load, signal, 15000, true), 3);
  assert.equal(await cache.read('one', load, signal, 0), 4);
});

test('concurrent subscribers share one request; cancelling one does not cancel another', async () => {
  const cache = new QueryCache<number>();
  const a = new AbortController(),
    b = new AbortController();
  let calls = 0;
  let complete!: (value: number) => void;
  let requestSignal!: AbortSignal;
  const load = (signal: AbortSignal) => {
    calls++;
    requestSignal = signal;
    return new Promise<number>((resolve) => {
      complete = resolve;
    });
  };
  const first = cache.read('key', load, a.signal, 1000);
  const second = cache.read('key', load, b.signal, 1000);
  await Promise.resolve();
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, false);
  complete(42);
  assert.equal(await second, 42);
  assert.equal(calls, 1);
});

test('abandoned and failed requests never overwrite cached data or prevent retry', async () => {
  const cache = new QueryCache<number>();
  const a = new AbortController();
  let complete!: (value: number) => void;
  const pending = cache.read(
    'key',
    () =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
    a.signal,
    1000,
  );
  await Promise.resolve();
  a.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await cache.read('key', async () => 2, new AbortController().signal, 1000);
  complete(1);
  await Promise.resolve();
  assert.equal(cache.peek('key'), 2);
  await assert.rejects(
    cache.read(
      'key',
      async () => {
        throw new Error('failed');
      },
      new AbortController().signal,
      0,
    ),
    /failed/,
  );
  assert.equal(cache.peek('key'), 2);
  assert.equal(
    await cache.read('key', async () => 3, new AbortController().signal, 0),
    3,
  );
});

test('cache evicts old entries at its bound and does not start pre-cancelled reads', async () => {
  const cache = new QueryCache<number>(2);
  const signal = new AbortController().signal;
  for (const value of [1, 2, 3])
    await cache.read(String(value), async () => value, signal, 1000);
  assert.equal(cache.peek('1'), undefined);
  assert.equal(cache.peek('3'), 3);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    cache.read(
      '4',
      async () => {
        throw new Error('must not run');
      },
      cancelled.signal,
      1000,
    ),
    { name: 'AbortError' },
  );
});
