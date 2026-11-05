import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import { applyEdits } from '../../src/plugins/shared/agent-editing/index.js';
import {
  checkTarget,
  parseTarget,
} from '../../src/plugins/shared/file-application/target.js';
const context: RuntimeContext = new RuntimeContext().extend({
  experimentId: 'test',
  callId: 'test',
  bindingId: 'test',
  idempotencyKey: 'test',
  directory: '/unused',
  signal: new AbortController().signal,
  cleanup: new AbortController().signal,
});

test('resource edit validation rejects the entire plan before writing any file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-edit-preflight-'));
  try {
    await writeFile(join(root, 'first.md'), 'original');
    for (const edits of [
      [
        { path: 'first.md', content: 'changed' },
        { path: 'first.md', content: null },
      ],
      [
        { path: 'first.md', content: 'changed' },
        { path: '../outside.md', content: 'invalid' },
      ],
    ]) {
      await assert.rejects(applyEdits(root, { edits }, context));
      assert.equal(await readFile(join(root, 'first.md'), 'utf8'), 'original');
    }
    await assert.rejects(
      applyEdits(
        root,
        { edits: [{ path: 'first.md', content: 'changed' }] },
        context,
        {
          maxChangedBytes: 1,
        },
      ),
      /byte limit/,
    );
    assert.equal(await readFile(join(root, 'first.md'), 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editor and Target accept many large changes when limits are omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-edit-optional-limits-'));
  try {
    const content = 'x'.repeat(1024 * 1024 + 1);
    const edits = [
      { path: 'files/large.md', content },
      ...Array.from({ length: 32 }, (_, i) => ({
        path: `files/${i}.md`,
        content: 'new',
      })),
    ];
    await applyEdits(root, { edits }, context);
    assert.equal(
      (await readFile(join(root, 'files/large.md'))).length,
      content.length,
    );
    const after = Object.fromEntries(
      edits.map(({ path, content }) => [
        path,
        { content: Buffer.from(content).toString('base64'), mode: 0o644 },
      ]),
    );
    const target = parseTarget({
      schemaVersion: 'rsi.target/v1',
      id: 'test',
      entries: [
        {
          path: 'files',
          description: 'Editable files',
          kind: 'directory',
          changes: ['create'],
        },
      ],
    });
    assert.equal(checkTarget({}, after, target).length, 33);
    assert.throws(
      () => checkTarget({}, after, { ...target, maxChangedFiles: 32 }),
      /maxChangedFiles/,
    );
    assert.throws(
      () => checkTarget({}, after, target, { maxChangedBytes: 1024 }),
      /maxChangedBytes/,
    );
    assert.throws(
      () =>
        checkTarget({}, after, {
          ...target,
          entries: [{ ...target.entries[0]!, maxBytes: 1024 }],
        }),
      /content size/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preflight permits deleting a file before creating a directory at that path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-edit-directory-'));
  try {
    await writeFile(join(root, 'instructions'), 'old file');
    await applyEdits(
      root,
      {
        edits: [
          { path: 'instructions', content: null },
          { path: 'instructions/skill.md', content: 'nested instructions' },
        ],
      },
      context,
    );
    assert.equal(
      await readFile(join(root, 'instructions/skill.md'), 'utf8'),
      'nested instructions',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('resource edits enforce authorized paths and never follow filesystem symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-edit-'));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/secret.txt'), 'unchanged');
    await symlink(
      join(root, 'outside'),
      join(root, 'workspace/alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      applyEdits(
        join(root, 'workspace'),
        { edits: [{ path: 'alias/secret.txt', content: 'bad' }] },
        context,
      ),
      /symbolic|symlink/,
    );
    assert.equal(
      await readFile(join(root, 'outside/secret.txt'), 'utf8'),
      'unchanged',
    );
    await assert.rejects(
      applyEdits(
        join(root, 'workspace'),
        { edits: [{ path: 'other.md', content: 'bad' }] },
        context,
        { allowedPaths: ['memory.md'] },
      ),
      /authorized/,
    );
    await applyEdits(
      join(root, 'workspace'),
      { edits: [{ path: 'memory.md', content: '' }] },
      context,
      { allowedPaths: ['memory.md'] },
    );
    assert.equal(await readFile(join(root, 'workspace/memory.md'), 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
