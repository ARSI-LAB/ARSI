import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { withSnapshot } from '../../.github/review/prepare.mjs';
import { git } from '../../.github/review/process.mjs';

test('subsequent review rounds follow the current PR history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'arsi-review-history-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (...args) => git(root, args, { env });
  const write = async (path, content) => {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const commit = async (message, ...options) => {
    await run('add', '.');
    await run('commit', ...options, '-m', message);
    return (await run('rev-parse', 'HEAD')).trim();
  };
  const snapshot = async (previous) => {
    const head = (await run('rev-parse', 'HEAD')).trim();
    const base = (await run('rev-parse', 'master')).trim();
    await run('update-ref', 'refs/pull/1/head', head);
    return withSnapshot(
      {
        root,
        trusted: base,
        remote: root,
        previous,
        pr: { number: 1, base: { sha: base }, head: { sha: head } },
      },
      ({ patch, context, fullPaths }) => ({ patch, context, fullPaths }),
    );
  };

  await run('init', '--template=', '--initial-branch=master');
  await run('config', 'user.name', 'Review fixture');
  await run('config', 'user.email', 'fixture@invalid');
  const guide = 'docs/runtime.md';
  await write(guide, 'Trusted runtime guide');
  await write('AGENTS.md', 'Rules');
  await write('.github/review/system-prompt.md', 'Review prompt');
  await write('.github/review/finding.schema.json', '{}');
  await write(
    '.github/review/context-routes.json',
    JSON.stringify([
      {
        paths: ['src/runtime/'],
        documents: [guide, 'docs/moved.md'],
        topics: [],
      },
    ]),
  );
  await commit('base');
  await run('switch', '-c', 'topic');
  const runtime = 'src/runtime/change.ts';
  const unit = 'tests/unit/change.ts';
  await write(runtime, 'first PR change\n');
  const first = await commit('first round');
  await write(unit, 'second PR change\n');
  const second = await commit('second round');

  await t.test(
    'fast-forward uses the incremental patch and full PR guide routes',
    async () => {
      const { patch, context, fullPaths } = await snapshot(first);
      assert.match(patch, /second PR change/);
      assert.doesNotMatch(patch, /first PR change/);
      assert.deepEqual(fullPaths, [runtime, unit]);
      assert.deepEqual(context, [
        { path: 'AGENTS.md', content: 'Rules' },
        { path: guide, content: 'Trusted runtime guide' },
      ]);
    },
  );

  await write(unit, 'amended PR change\n');
  const amended = await commit('amended round', '--amend');
  await run('update-ref', 'refs/pull/1/head', amended);
  await run('reflog', 'expire', '--expire=now', '--all');
  await run('gc', '--prune=now');

  await t.test(
    'amend falls back to the full PR after the old head is pruned',
    async () => {
      await assert.rejects(run('cat-file', '-e', second));
      const { patch } = await snapshot(second);
      assert.match(patch, /first PR change/);
      assert.match(patch, /amended PR change/);
    },
  );

  await run('switch', 'master');
  await write('base-only.txt', 'unrelated upstream change\n');
  await commit('advance master');
  await run('switch', 'topic');
  await run('branch', 'old-topic', amended);
  await run('rebase', 'master');

  const assertCurrentPr = async () => {
    const { patch } = await snapshot(amended);
    assert.match(patch, /first PR change/);
    assert.match(patch, /amended PR change/);
    assert.doesNotMatch(patch, /base-only|unrelated upstream change/);
  };
  await t.test(
    'rebase excludes unrelated upstream changes even when the old head exists',
    assertCurrentPr,
  );

  await run('switch', 'old-topic');
  await run('merge', '--no-edit', 'master');
  await t.test(
    'merging master into the PR also excludes upstream-only changes',
    assertCurrentPr,
  );
});
