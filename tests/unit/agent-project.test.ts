import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { RuntimeContext, parseFileTree } from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  prepareAgentProject,
  projectMarker,
} from '../../src/plugins/shared/agent-editing/project.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-agent-project-'));
  const directory = join(root, 'call');
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const context = new RuntimeContext().extend({ directory, artifacts });
  const prepare = () =>
    prepareAgentProject(
      context,
      'Read the candidate and propose JSON edits.',
      { 'candidate/prompt.md': 'original' },
      [],
      [],
    );
  const move = async (from: string, to: string): Promise<void> => {
    assert(from.startsWith(root + sep) && to.startsWith(root + sep));
    await rename(from, to);
  };
  return {
    root,
    directory,
    artifacts,
    prepare,
    move,
    close: async () => {
      assert.equal(dirname(root), tmpdir());
      assert(basename(root).startsWith('rsi-agent-project-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('concurrent project publication and repeat preparation preserve live edits and the original snapshot', async () => {
  const f = await fixture();
  try {
    const [first, concurrent] = await Promise.all([f.prepare(), f.prepare()]);
    assert.equal(concurrent, first);
    await writeFile(join(first, 'candidate/prompt.md'), 'live edit');
    assert.equal(await f.prepare(), first);
    assert.equal(
      await readFile(join(first, 'candidate/prompt.md'), 'utf8'),
      'live edit',
    );
    const snapshot = parseFileTree(
      await f.artifacts.readJson(`artifact:${basename(dirname(first))}`),
    );
    const original = snapshot.files.find(
      (file) => file.path === 'candidate/prompt.md',
    );
    assert(original);
    assert.equal(
      Buffer.from(original.base64, 'base64').toString('utf8'),
      'original',
    );
    assert.equal(
      (await readdir(f.directory)).filter((name) =>
        name.startsWith('agent-input-'),
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

for (const invalid of ['file', 'missing-marker', 'nonempty-marker'] as const) {
  test(`project reuse rejects an existing ${invalid} without replacing its contents`, async () => {
    const f = await fixture();
    try {
      const project = await f.prepare();
      if (invalid === 'file') {
        await f.move(project, project + '.saved');
        await writeFile(project, 'occupied');
      } else if (invalid === 'missing-marker') {
        await rm(join(project, projectMarker));
      } else {
        await writeFile(join(project, projectMarker), 'invalid');
      }
      await assert.rejects(f.prepare, /Agent project|ENOENT/);
      assert.equal(
        await readFile(
          invalid === 'file' ? project : join(project, 'candidate/prompt.md'),
          'utf8',
        ),
        invalid === 'file' ? 'occupied' : 'original',
      );
    } finally {
      await f.close();
    }
  });
}

test('project reuse rejects an ownership path redirected through a directory link', async () => {
  const f = await fixture();
  try {
    const project = await f.prepare();
    const parent = dirname(project);
    const relocated = join(f.root, 'relocated');
    await f.move(parent, relocated);
    await symlink(
      relocated,
      parent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(f.prepare, /Agent project/);
    assert.equal(
      await readFile(join(relocated, 'project/candidate/prompt.md'), 'utf8'),
      'original',
    );
  } finally {
    await f.close();
  }
});

test('project preparation rejects a redirected parent before creating any child directory', async () => {
  const f = await fixture();
  try {
    const project = await f.prepare();
    const projects = dirname(dirname(project));
    const relocated = join(f.root, 'relocated');
    await f.move(projects, relocated);
    await symlink(
      relocated,
      projects,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = await readdir(relocated);
    const context = new RuntimeContext().extend({
      directory: f.directory,
      artifacts: f.artifacts,
    });
    await assert.rejects(
      prepareAgentProject(context, 'Different input', {}, [], []),
      /Agent project/,
    );
    assert.deepEqual(await readdir(relocated), before);
  } finally {
    await f.close();
  }
});
