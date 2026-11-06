import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedLines,
  loadCandidateDiff,
} from '../../web/features/experiments/candidate-diff.js';

test('text diff preserves additions, deletions, replacement context and line numbers', () => {
  const lines = changedLines('header\nold\ntail', 'header\nnew\ntail');
  assert.deepEqual(
    lines.map((line) => [line.kind, line.text, line.before, line.after]),
    [
      ['context', 'header', 1, 1],
      ['removed', 'old', 2, null],
      ['added', 'new', null, 2],
      ['context', 'tail', 3, 3],
    ],
  );
  assert.deepEqual(
    changedLines(null, 'added').map((line) => line.kind),
    ['added'],
  );
  assert.deepEqual(
    changedLines('removed', null).map((line) => line.kind),
    ['removed'],
  );
  assert.deepEqual(changedLines('same', 'same'), []);
});
test('snapshot comparison uses GET only, detects equal-size edits, and never treats restricted or truncated text as unchanged', async (t) => {
  const files: Record<string, Record<string, string>> = {
    parent: {
      'edit.txt': 'old',
      'same.txt': 'same',
      'remove.txt': 'deleted',
      'secret.txt': 'hidden',
      'large.txt': 'prefix',
    },
    current: {
      'edit.txt': 'new',
      'same.txt': 'same',
      'add.txt': 'added',
      'secret.txt': 'hidden',
      'large.txt': 'prefix',
    },
  };
  const methods: string[] = [];
  const requestedPaths: (string | null)[] = [];
  let useDigests = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? '');
      const url = new URL(String(input), 'http://localhost');
      const ref = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const entries = Object.entries(files[ref]!).map(([path, text]) => ({
        path,
        bytes: text.length,
        ...(useDigests && ['same.txt', 'edit.txt'].includes(path)
          ? { digest: text }
          : {}),
      }));
      const path = url.searchParams.get('path');
      requestedPaths.push(path);
      return new Response(
        JSON.stringify({
          ref,
          kind: 'file-tree',
          files: { items: entries, total: entries.length, nextOffset: null },
          content: path
            ? { text: files[ref]![path], truncated: path === 'large.txt' }
            : null,
          unavailable:
            path === 'secret.txt'
              ? 'Sensitive file content is restricted.'
              : null,
        }),
      );
    },
  );
  const result = await loadCandidateDiff(
    'experiment',
    'parent',
    'current',
    new AbortController().signal,
  );
  assert.equal(result.unchanged, 1);
  assert.deepEqual(
    result.changes.map((change) => [change.path, change.kind]),
    [
      ['add.txt', 'added'],
      ['edit.txt', 'modified'],
      ['large.txt', 'unavailable'],
      ['remove.txt', 'removed'],
      ['secret.txt', 'unavailable'],
    ],
  );
  assert.ok(methods.every((method) => method === 'GET'));
  useDigests = true;
  requestedPaths.length = 0;
  const optimized = await loadCandidateDiff(
    'experiment-digests',
    'parent',
    'current',
    new AbortController().signal,
  );
  assert.deepEqual(optimized, result);
  assert.equal(requestedPaths.includes('same.txt'), false);
  assert.equal(requestedPaths.filter((path) => path === 'edit.txt').length, 2);
  requestedPaths.length = 0;
  const scoped = await loadCandidateDiff(
    'experiment-digests',
    'parent',
    'current',
    new AbortController().signal,
    'edit.',
  );
  assert.equal(
    requestedPaths.length,
    0,
    'reuse indexes and previews across scopes',
  );
  assert.equal(scoped.total, 1);
  assert.deepEqual(
    scoped.changes.map((change) => change.path),
    ['edit.txt'],
  );
  assert.ok(
    requestedPaths.every((path) => path === null || path === 'edit.txt'),
  );
  await loadCandidateDiff(
    'experiment-digests',
    'parent',
    'current',
    new AbortController().signal,
    '',
    true,
  );
  assert.ok(
    requestedPaths.length > 0,
    'explicit refresh bypasses snapshot caches',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadCandidateDiff('experiment', 'parent', 'current', controller.signal),
    { name: 'AbortError' },
  );
});
