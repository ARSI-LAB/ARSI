import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  access,
  rename,
} from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
test('immutable artifacts round-trip and reject symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-store-'));
  try {
    const store = new FileArtifacts(join(root, 'store'));
    await mkdir(join(root, 'input'));
    await writeFile(join(root, 'input/input.txt'), 'one');
    const ref = await store.capture(join(root, 'input'));
    await store.materialize(ref, join(root, 'copy'));
    assert.equal(await readFile(join(root, 'copy/input.txt'), 'utf8'), 'one');
    await mkdir(join(root, 'outside'));
    await symlink(
      join(root, 'outside'),
      join(root, 'input/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      store.capture(join(root, 'input')),
      /symbolic|symlink/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('facts write only their records and reject unsafe identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-facts-'));
  try {
    const store = new FileFacts(root);
    await store.write('calls', 'one', {
      experimentId: 'run',
      status: 'succeeded',
    });
    assert.equal((await store.read('calls', 'one')).status, 'succeeded');
    assert.deepEqual(await readdir(root), ['calls']);
    await assert.rejects(store.write('../calls', 'one', {}));
    await assert.rejects(store.write('calls', '../escape', {}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed fact publication preserves the previous record and removes temporary data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-facts-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileFacts(root);
  await store.write('calls', 'one', { status: 'original' });
  const destination = join(root, 'calls', 'one.json');
  const originalRename = fs.promises.rename;
  const failure = new Error('publication failed');
  const mocked = t.mock.method(
    fs.promises,
    'rename',
    async (...args: Parameters<typeof rename>): Promise<void> => {
      if (args[1] === destination) throw failure;
      await originalRename(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      store.write('calls', 'one', { status: 'replacement' }),
      (error) => error === failure,
    );
    assert.deepEqual(await store.read('calls', 'one'), { status: 'original' });
    assert.deepEqual(await readdir(join(root, 'calls')), ['one.json']);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('fact writes preserve input snapshots and reject invalid JSON without replacing facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-facts-snapshot-'));
  try {
    const store = new FileFacts(root);
    const value = { experimentId: 'alpha', nested: { status: 'original' } };
    const pending = store.write('calls', 'one', value);
    value.experimentId = 'beta';
    value.nested.status = 'mutated';
    await pending;
    await assert.rejects(
      store.write('calls', 'one', { invalid: Number.NaN }),
      /Expected finite JSON data/,
    );
    assert.deepEqual(await store.read('calls', 'one'), {
      experimentId: 'alpha',
      nested: { status: 'original' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fact scans are lazy and read current records from other store instances', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-facts-scan-'));
  try {
    const store = new FileFacts(root);
    await store.write('calls', 'a', { status: 'first' });
    await store.write('calls', 'b', { status: 'before' });
    await store.write('calls', 'c', { status: 'unread' });
    const reads: string[] = [];
    const read = store.read.bind(store);
    t.mock.method(store, 'read', async (kind: string, id: string) => {
      reads.push(id);
      return read(kind, id);
    });
    const iterator = store.scan('calls');
    assert.deepEqual(reads, []);
    assert.deepEqual((await iterator.next()).value, { status: 'first' });
    assert.deepEqual(reads, ['a']);
    await new FileFacts(root).write('calls', 'b', { status: 'after' });
    assert.deepEqual((await iterator.next()).value, { status: 'after' });
    await iterator.return(undefined);
    assert.deepEqual(reads, ['a', 'b']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent fact writers publish complete independent records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-facts-concurrent-'));
  try {
    const stores = [new FileFacts(root), new FileFacts(root)];
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        stores[index % 2]!.write('calls', `call-${index}`, { index }),
      ),
    );
    const records = await stores[0]!.list('calls');
    assert.deepEqual(
      records
        .map((record) => record.index)
        .sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 12 }, (_, index) => index),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file trees round-trip files above 32 MiB and totals above 128 MiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-large-store-'));
  try {
    const store = new FileArtifacts(join(root, 'store'));
    const input = join(root, 'input');
    await mkdir(input);
    const content = Buffer.alloc(32 * 1024 * 1024 + 1, 0xa5);
    const names = ['first.bin', 'second.bin', 'third.bin', 'fourth.bin'];
    for (const name of names) await writeFile(join(input, name), content);

    const ref = await store.capture(input);
    const output = join(root, 'output');
    await store.materialize(ref, output);

    assert.deepEqual((await readdir(output)).sort(), [...names].sort());
    for (const name of names)
      assert.ok((await readFile(join(output, name))).equals(content), name);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file trees materialize more than 10000 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-many-files-'));
  try {
    const store = new FileArtifacts(join(root, 'store'));
    const files = Array.from({ length: 10001 }, (_, index) => ({
      path: `${index}.txt`,
      mode: 0o644,
      base64: 'eA==',
    }));
    const ref = await store.putJson({ kind: 'file-tree', files });
    const output = join(root, 'output');
    await store.materialize(ref, output);

    assert.deepEqual(
      (await readdir(output)).sort(),
      files.map((file) => file.path).sort(),
    );
    assert.equal(await readFile(join(output, '0.txt'), 'utf8'), 'x');
    assert.equal(await readFile(join(output, '10000.txt'), 'utf8'), 'x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent immutable writes publish complete data and materialization rejects malformed paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-publish-'));
  try {
    const store = new FileArtifacts(join(root, 'store'));
    const payload = { text: 'x'.repeat(100000) };
    const refs = await Promise.all(
      Array.from({ length: 8 }, () => store.putJson(payload)),
    );
    assert.equal(new Set(refs).size, 1);
    assert.deepEqual(await store.readJson(refs[0]), payload);
    const malicious = await store.putJson({
      kind: 'file-tree',
      files: [{ path: '../outside', mode: 420, base64: '' }],
    });
    await assert.rejects(
      store.materialize(malicious, join(root, 'out')),
      /path/,
    );
    const invalidBytes = await store.putJson({
      kind: 'file-tree',
      files: [
        { path: 'first.txt', mode: 0o644, base64: 'YQ==' },
        { path: 'second.txt', mode: 0o644, base64: 'invalid!' },
      ],
    });
    await assert.rejects(
      store.materialize(invalidBytes, join(root, 'partial')),
      /bytes/,
    );
    await assert.rejects(access(join(root, 'partial')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
