import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './process.mjs';

const cleanGit = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const shaPattern = /^[a-f0-9]{40}$/;
export function commitId(id) {
  if (!shaPattern.test(id)) throw new Error('Expected a full commit SHA');
  return id;
}

export function changedLines(patch) {
  const ranges = { LEFT: [], RIGHT: [] };
  for (const match of patch.matchAll(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    for (const [side, start, length] of [
      ['LEFT', match[1], match[2]],
      ['RIGHT', match[3], match[4]],
    ]) {
      const count = length === undefined ? 1 : Number(length);
      if (count) ranges[side].push([Number(start), Number(start) + count - 1]);
    }
  }
  return ranges;
}

async function diff(runGit, from, to, includePatch) {
  const options = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    from,
    to,
  ];
  const entries = (await runGit([...options, '--name-status', '-z'])).split(
    '\0',
  );
  const files = [];
  const patches = [];
  const anchors = new Map();
  for (let index = 0; index < entries.length - 1; ) {
    const status = entries[index++];
    const first = entries[index++];
    const paths = status.startsWith('R') ? [first, entries[index++]] : [first];
    const path = paths.at(-1);
    const patch = await runGit([...options, '--unified=0', '--', ...paths]);
    files.push(...paths);
    if (includePatch) patches.push(patch);
    anchors.set(path, changedLines(patch));
  }
  return { files, patch: patches.join('\n'), anchors };
}

async function stripProjectConfig(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (
      ['.codex', '.agents'].includes(entry.name.toLowerCase()) ||
      entry.isSymbolicLink()
    ) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) await stripProjectConfig(path);
  }
}

export async function withSnapshot(config, use) {
  const { root, trusted, remote, pr, previous, signal } = config;
  const temp = await mkdtemp(join(tmpdir(), 'arsi-review-'));
  try {
    const repo = join(temp, 'objects.git');
    const worktree = join(temp, 'checkout');
    const env = cleanGit;
    const runGit = (args) => git(repo, args, { env, signal });
    await git(temp, ['init', '--bare', '--template=', repo], { env, signal });
    // Share objects via fetch, never write PR refs or change the active index/worktree.
    await runGit([
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      root,
      commitId(trusted),
    ]);
    let head, base;
    if (pr) {
      await runGit([
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        remote,
        'refs/pull/' + pr.number + '/head',
      ]);
      head = (await runGit(['rev-parse', 'FETCH_HEAD'])).trim();
      if (head !== commitId(pr.head.sha))
        throw new Error('PR head changed during prepare');
      base = commitId(pr.base.sha);
      await runGit(['fetch', '--no-tags', remote, base]);
      if (previous)
        await runGit(['fetch', '--no-tags', remote, commitId(previous)]);
    } else {
      // Include staged, unstaged and non-ignored new files without changing the real index.
      const localEnv = {
        ...process.env,
        GIT_INDEX_FILE: join(temp, 'local.index'),
      };
      await git(root, ['read-tree', 'HEAD'], { env: localEnv, signal });
      await git(root, ['add', '--all', '--', '.'], { env: localEnv, signal });
      const tree = (
        await git(root, ['write-tree'], { env: localEnv, signal })
      ).trim();
      const author = {
        ...localEnv,
        GIT_AUTHOR_NAME: 'Local review',
        GIT_COMMITTER_NAME: 'Local review',
        GIT_AUTHOR_EMAIL: 'local@invalid',
        GIT_COMMITTER_EMAIL: 'local@invalid',
      };
      head = (
        await git(
          root,
          [
            '-c',
            'commit.gpgSign=false',
            'commit-tree',
            tree,
            '-p',
            'HEAD',
            '-m',
            'Local review snapshot',
          ],
          { env: author, signal },
        )
      ).trim();
      await runGit(['fetch', '--no-tags', root, commitId(head)]);
      base = trusted;
    }
    const mergeBase = (await runGit(['merge-base', base, head])).trim();
    const incremental = await diff(runGit, previous || mergeBase, head, true);
    const full = previous
      ? await diff(runGit, mergeBase, head, false)
      : incremental;
    await runGit(['worktree', 'add', '--detach', worktree, head]);
    await stripProjectConfig(worktree);
    const trustedBlob = (path) => runGit(['show', trusted + ':' + path]);
    const skill = 'skills/team-pr-review/SKILL.md';
    const filesAtBase = new Set(
      (await runGit(['ls-tree', '-r', '--name-only', '-z', trusted])).split(
        '\0',
      ),
    );
    const routes = JSON.parse(
      await trustedBlob('.github/review/context-routes.json'),
    );
    const sourcePaths = new Set(['AGENTS.md']);
    if (filesAtBase.has(skill)) sourcePaths.add(skill);
    for (const route of routes.filter((route) =>
      route.paths.some((prefix) =>
        incremental.files.some((file) =>
          prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix,
        ),
      ),
    )) {
      for (const path of route.documents) sourcePaths.add(path);
      for (const topic of route.topics) {
        const path = 'skills/team-pr-review/references/' + topic + '.md';
        if (filesAtBase.has(skill) && filesAtBase.has(path))
          sourcePaths.add(path);
      }
    }
    const context = [];
    for (const path of sourcePaths)
      context.push({ path, content: await trustedBlob(path) });
    const schemaFile = join(temp, 'finding.schema.json');
    await writeFile(
      schemaFile,
      await trustedBlob('.github/review/finding.schema.json'),
    );
    const emptyGhConfig = join(temp, 'empty-gh');
    await mkdir(emptyGhConfig);
    return await use({
      worktree,
      temp,
      emptyGhConfig,
      head,
      patch: incremental.patch,
      fullPaths: full.files,
      anchors: full.anchors,
      context,
      skillLoaded: sourcePaths.has(skill),
      schemaFile,
      schema: JSON.parse(await readFile(schemaFile, 'utf8')),
      prompt: await trustedBlob('.github/review/system-prompt.md'),
    });
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 250,
    });
  }
}
