import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFileTree } from '../../src/contracts/index.js';

test('file trees preserve empty, text and binary entries in their declared order', () => {
  assert.deepEqual(parseFileTree({ kind: 'file-tree', files: [] }), {
    kind: 'file-tree',
    files: [],
  });
  const tree = {
    kind: 'file-tree',
    files: [
      {
        path: 'docs/说明.md',
        mode: 0o644,
        base64: Buffer.from('你好').toString('base64'),
      },
      {
        path: 'binary.dat',
        mode: 0o755,
        base64: Buffer.from([0, 255, 1]).toString('base64'),
      },
      { path: 'empty', mode: 0, base64: '' },
    ],
  };
  assert.deepEqual(parseFileTree(tree), tree);
});

test('file trees reject invalid structure, paths, modes and noncanonical bytes', () => {
  for (const value of [
    null,
    {},
    { kind: 'other', files: [] },
    { kind: 'file-tree', files: {} },
  ])
    assert.throws(() => parseFileTree(value));
  const file = { path: 'valid.txt', mode: 0o644, base64: 'YQ==' };
  for (const path of [
    '',
    '/absolute',
    '../escape',
    'a/../b',
    './a',
    'a//b',
    'a/',
    'a\\b',
    'C:/outside',
    'C:outside',
    'a\0b',
  ])
    assert.throws(
      () => parseFileTree({ kind: 'file-tree', files: [{ ...file, path }] }),
      /path/i,
    );
  for (const mode of [undefined, '644', -1, 1.5, 0o1000]) {
    const entry: Record<string, unknown> = { ...file, mode };
    if (mode === undefined) delete entry.mode;
    assert.throws(
      () => parseFileTree({ kind: 'file-tree', files: [entry] }),
      /mode/i,
    );
  }
  for (const base64 of [undefined, 4, 'not base64!', 'YQ', 'YR==']) {
    const entry: Record<string, unknown> = { ...file, base64 };
    if (base64 === undefined) delete entry.base64;
    assert.throws(
      () => parseFileTree({ kind: 'file-tree', files: [entry] }),
      /bytes|base64/i,
    );
  }
  assert.throws(
    () => parseFileTree({ kind: 'file-tree', files: [file, file] }),
    /duplicate/i,
  );
});
