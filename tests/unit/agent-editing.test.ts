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
      [
        { path: 'first.md', content: 'changed' },
        { path: 'large.md', content: 'x'.repeat(131073) },
      ],
    ]) {
      await assert.rejects(applyEdits(root, { edits }, context));
      assert.equal(await readFile(join(root, 'first.md'), 'utf8'), 'original');
    }
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
