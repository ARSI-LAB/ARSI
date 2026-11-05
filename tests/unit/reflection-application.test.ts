import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
  realpath,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { JsonObject, FileTreeFile } from '../../src/contracts/index.js';
import {
  applicationContract,
  defineContract,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
import { RevisionApplication } from '../../src/runtime/revisions/application.js';
import { acquireResourceGate } from '../../src/runtime/revisions/exclusion.js';
import {
  resourcePath,
  selectedResourceFields,
  validateEditableRoots,
  validateEditableDestinations,
  pathContains,
} from '../../src/runtime/revisions/resources.js';
import { object, string } from '../../src/shared/json.js';
const file = (path: string, value: string, mode = 0o644): FileTreeFile => ({
  path,
  mode,
  base64: Buffer.from(value).toString('base64'),
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-apply-'));
  const project = join(root, 'project'),
    directory = join(root, 'runtime'),
    guidance = join(project, 'guidance');
  await mkdir(guidance, { recursive: true });
  const facts = new FileFacts(join(directory, 'facts')),
    artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const app = new RevisionApplication({
    rootDirectory: project,
    directory,
    facts,
    artifacts,
  });
  const prefix = resourcePath('worker', '/guidance');
  const resource = {
    pointer: '/guidance',
    kind: 'directory',
    path: guidance,
    artifactPath: prefix,
  };
  const save = async (
    id: string,
    files: FileTreeFile[],
    extra: JsonObject = {},
  ): Promise<void> => {
    const resourceRef = await artifacts.putJson({ kind: 'file-tree', files });
    await facts.write('revisions', id, {
      ref: id,
      experimentId: 'experiment',
      binding: 'worker',
      policyScopeId: 'root',
      pluginRef: 'worker.agent',
      kind: id === 'revision-initial' ? 'initial' : 'generated',
      rootRef: 'revision-initial',
      parentRef: id === 'revision-initial' ? null : 'revision-initial',
      sourceResources: [resource],
      resourceRef,
      ...extra,
    });
  };
  await save('revision-initial', [file(prefix + '/original.md', 'original')]);
  return {
    root,
    project,
    directory,
    guidance,
    facts,
    artifacts,
    app,
    prefix,
    resource,
    save,
  };
}
test('configured collection resources match paths and editable roots reject all overlaps', () => {
  const schema = {
    type: 'object',
    properties: {
      skills: {
        type: 'array',
        items: { type: 'string', 'x-rsi-path': 'directory' },
      },
      prompt: { type: 'string', 'x-rsi-path': 'file' },
    },
  };
  assert.deepEqual(
    selectedResourceFields(schema, { skills: ['a', 'b'], prompt: 'p' }, [
      'skills',
    ]).map((field) => field.pointer),
    ['/skills/0', '/skills/1'],
  );
  assert.throws(
    () => selectedResourceFields(schema, { skills: [] }, ['skills']),
    /not declared/,
  );
  assert.throws(
    () =>
      validateEditableRoots([
        {
          binding: 'A',
          pointer: '/guidance',
          kind: 'directory',
          path: '/tmp/resources',
        },
        {
          binding: 'B',
          pointer: '/prompt',
          kind: 'file',
          path: '/tmp/resources/child',
        },
      ]),
    /A\/guidance.*B\/prompt/,
  );
});
test('saved versions directly overwrite owned snapshots and the initial revision restores originals', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const sibling = join(f.project, 'sibling.txt');
  await writeFile(sibling, 'untouched');
  await writeFile(join(f.guidance, 'original.md'), 'local edits');
  await f.save('revision-r1', [
    file(f.prefix + '/original.md', 'one'),
    file('bindings/other/resources/guidance/private.md', 'other binding'),
  ]);
  await f.save('revision-r3', [file(f.prefix + '/added.md', 'three')]);
  assert.equal((await f.app.list()).length, 3);
  assert.equal((await f.app.list('other')).length, 0);
  const show = await f.app.show('revision-r3');
  assert.equal(show.applicationAllowed, true);
  assert.deepEqual((show.changes as JsonObject[]).map((c) => c.action).sort(), [
    'add',
    'remove',
  ]);
  await f.app.apply('revision-r1');
  assert.equal(await readFile(join(f.guidance, 'original.md'), 'utf8'), 'one');
  await f.app.apply('revision-r3');
  await assert.rejects(readFile(join(f.guidance, 'original.md')), /ENOENT/);
  assert.equal(await readFile(join(f.guidance, 'added.md'), 'utf8'), 'three');
  assert.equal((await f.app.apply('revision-r3')).status, 'unchanged');
  await f.app.apply('revision-initial');
  assert.equal(
    await readFile(join(f.guidance, 'original.md'), 'utf8'),
    'original',
  );
  await assert.rejects(readFile(join(f.guidance, 'added.md')), /ENOENT/);
  assert.equal(await readFile(sibling, 'utf8'), 'untouched');
  await f.save('revision-empty', []);
  await f.app.apply('revision-empty');
  await assert.rejects(readFile(join(f.guidance, 'original.md')), /ENOENT/);
});
test('snapshot name collisions follow the destination filesystem before any resource changes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const probe = join(f.guidance, 'CaseProbe');
  await writeFile(probe, 'probe', { flag: 'wx' });
  const caseInsensitive = await lstat(join(f.guidance, 'caseprobe')).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
  await rm(probe);
  t.diagnostic(
    `Destination filesystem is case-${caseInsensitive ? 'insensitive' : 'sensitive'} (${process.platform})`,
  );
  await writeFile(join(f.guidance, 'original.md'), 'preserve local content');
  for (const [upper, lower] of [
    ['Rules.md', 'rules.md'],
    ['new/sub/Rules.md', 'new/sub/rules.md'],
    ['Rules.md', 'rules.md/child.md'],
  ]) {
    await f.save('revision-case', [
      file(f.prefix + '/' + upper, 'upper'),
      file(f.prefix + '/' + lower, 'lower'),
    ]);
    const shown = await f.app.show('revision-case');
    assert.equal(shown.applicationAllowed, !caseInsensitive);
    if (caseInsensitive) {
      assert.match(String(shown.restrictions), /alias|collision/);
      await assert.rejects(f.app.apply('revision-case'), /alias|collision/);
      assert.deepEqual(await readdir(f.guidance), ['original.md']);
      assert.equal(
        await readFile(join(f.guidance, 'original.md'), 'utf8'),
        'preserve local content',
      );
    } else {
      await f.app.apply('revision-case');
      assert.equal(await readFile(join(f.guidance, upper!), 'utf8'), 'upper');
      assert.equal(await readFile(join(f.guidance, lower!), 'utf8'), 'lower');
      assert.equal((await f.app.apply('revision-case')).status, 'unchanged');
    }
  }
});
test('filesystem name probes clean up on I/O failure without applying resource changes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.guidance, 'original.md'), 'preserve');
  await f.save('revision-probe', [
    file(f.prefix + '/a.md', 'a'),
    file(f.prefix + '/b.md', 'b'),
  ]);
  const original = filesystem.open;
  filesystem.open = async (...args) => {
    if (String(args[0]).includes('.rsi-name-check-'))
      throw new Error('injected name probe failure');
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    const shown = await f.app.show('revision-probe');
    assert.equal(shown.applicationAllowed, false);
    assert.match(String(shown.restrictions), /injected name probe failure/);
    await assert.rejects(
      f.app.apply('revision-probe'),
      /injected name probe failure/,
    );
    assert.deepEqual(await readdir(f.guidance), ['original.md']);
    assert.equal(
      await readFile(join(f.guidance, 'original.md'), 'utf8'),
      'preserve',
    );
  } finally {
    filesystem.open = original;
    syncBuiltinESMExports();
  }
  assert.equal((await f.app.apply('revision-probe')).status, 'applied');
  assert.deepEqual((await readdir(f.guidance)).sort(), ['a.md', 'b.md']);
});
test('inspection retains protected and legacy snapshots without authorizing application', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(f.app.show('revision-missing'), /Unknown revision/);
  const protectedResource = {
    ...f.resource,
    path: join(f.project, 'dist', 'guidance'),
  };
  await f.save(
    'revision-initial',
    [file(f.prefix + '/initial.md', 'snapshot')],
    { sourceResources: [protectedResource] },
  );
  const protectedShow = await f.app.show('revision-initial');
  assert.equal(protectedShow.applicationAllowed, false);
  assert.equal((protectedShow.snapshot as JsonObject[]).length, 1);
  await assert.rejects(
    f.app.apply('revision-initial'),
    /Protected destination/,
  );
  const initial = await f.facts.read('revisions', 'revision-initial');
  delete initial.sourceResources;
  delete initial.rootRef;
  await f.facts.write('revisions', 'revision-legacy', {
    ...initial,
    ref: 'revision-legacy',
  });
  assert.equal(
    object((await f.app.list()).find((r) => r.revisionID === 'revision-legacy'))
      .applicationMetadata,
    false,
  );
  const legacy = await f.app.show('revision-legacy');
  assert.match(String(legacy.restrictions), /Legacy revision/);
  assert.equal((legacy.snapshot as JsonObject[]).length, 1);
});
test('all destination and snapshot validation precedes the first write', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.guidance, 'original.md'), 'preserve');
  const invalidSets = [
    [
      file(f.prefix + '/ok.md', 'would write'),
      file(f.prefix + '/nested', 'a'),
      file(f.prefix + '/nested/file.md', 'collision'),
    ],
    [
      file(f.prefix + '/ok.md', 'would write'),
      file(f.prefix + '/con.txt', 'reserved'),
    ],
    [
      file(f.prefix + '/ok.md', 'would write'),
      file(f.prefix + '/trailing. ', 'alias'),
    ],
    [
      file(f.prefix + '/ok.md', 'would write'),
      file(f.prefix + '/node_modules/unsafe.md', 'protected'),
    ],
  ];
  for (const files of invalidSets) {
    await f.save('revision-invalid', files);
    await assert.rejects(
      f.app.apply('revision-invalid'),
      /collision|Unsafe resource entry/,
    );
    await assert.rejects(readFile(join(f.guidance, 'ok.md')), /ENOENT/);
  }
  await f.save('revision-redirect', [], {
    sourceResources: [{ ...f.resource, path: join(f.project, 'elsewhere') }],
  });
  await assert.rejects(
    f.app.apply('revision-redirect'),
    /differs from its initial root/,
  );
  const alias = {
    ...f.resource,
    pointer: '/other',
    artifactPath: resourcePath('worker', '/other'),
    path: join(f.guidance, 'child'),
  };
  await f.save('revision-initial', [], {
    sourceResources: [f.resource, alias],
  });
  await assert.rejects(f.app.apply('revision-initial'), /Overlapping editable/);
  assert.equal(
    await readFile(join(f.guidance, 'original.md'), 'utf8'),
    'preserve',
  );
});
test(
  'Windows device namespace aliases cannot bypass destination ownership checks',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const namespaced = '\\\\?\\' + f.guidance;
    await f.save(
      'revision-initial',
      [file(f.prefix + '/unsafe.md', 'must not write')],
      { sourceResources: [{ ...f.resource, path: namespaced }] },
    );
    const shown = await f.app.show('revision-initial');
    assert.equal(shown.applicationAllowed, false);
    assert.match(String(shown.restrictions), /namespace destination aliases/);
    await assert.rejects(
      f.app.apply('revision-initial'),
      /namespace destination aliases/,
    );
    await assert.rejects(readFile(join(f.guidance, 'unsafe.md')), /ENOENT/);
    const device = '\\\\.\\' + f.guidance;
    await f.save('revision-initial', [], {
      sourceResources: [{ ...f.resource, path: device }],
    });
    await assert.rejects(
      f.app.apply('revision-initial'),
      /namespace destination aliases/,
    );
  },
);
test(
  'existing Windows short-name aliases cannot bypass runtime-root protection or editable overlap checks',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const canonicalRuntime = await realpath(f.directory);
    const target = join(canonicalRuntime, 'protected.md');
    await writeFile(target, 'runtime content');
    await f.save('revision-initial', [file(f.prefix, 'must not write')], {
      sourceResources: [{ ...f.resource, kind: 'file', path: target }],
    });
    assert.equal(
      (await f.app.show('revision-initial')).applicationAllowed,
      false,
    );
    await assert.rejects(
      f.app.apply('revision-initial'),
      /Protected destination/,
    );
    assert.equal(await readFile(target, 'utf8'), 'runtime content');
    await assert.rejects(
      validateEditableDestinations([
        {
          binding: 'short',
          pointer: '/guidance',
          kind: 'directory',
          path: f.guidance,
        },
        {
          binding: 'long',
          pointer: '/guidance',
          kind: 'directory',
          path: await realpath(f.guidance),
        },
      ]),
      /Overlapping editable destinations short\/guidance.*long\/guidance/,
    );
    assert.equal(
      pathContains(
        '\\\\server\\share\\resources',
        '\\\\SERVER\\share\\resources\\rules.md',
      ),
      true,
    );
  },
);
test('links in destination descendants and ancestors are rejected', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.md'), 'outside');
  await symlink(
    outside,
    join(f.guidance, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(f.app.apply('revision-initial'), /Linked destination/);
  assert.equal(await readFile(join(outside, 'keep.md'), 'utf8'), 'outside');
  await rm(join(f.guidance, 'linked'));
  await rm(f.guidance, { recursive: true });
  await symlink(
    outside,
    f.guidance,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(f.app.apply('revision-initial'), /Linked destination/);
});
test('initial file revisions preserve bytes and supported modes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const target = join(f.project, 'prompt.md'),
    artifactPath = resourcePath('worker', '/prompt');
  const mapping = {
    pointer: '/prompt',
    kind: 'file',
    path: target,
    artifactPath,
  };
  await f.save(
    'revision-initial',
    [file(artifactPath, '\0binary\r\n', 0o600)],
    { sourceResources: [mapping] },
  );
  await f.app.apply('revision-initial');
  assert.deepEqual(await readFile(target), Buffer.from('\0binary\r\n'));
  if (process.platform !== 'win32')
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
  assert.equal((await f.app.apply('revision-initial')).status, 'unchanged');
});
test('restoring an absent empty directory reports its creation before becoming a no-op', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.save('revision-initial', []);
  await rm(f.guidance, { recursive: true });
  const change = { action: 'add', kind: 'directory', path: f.guidance };
  assert.deepEqual((await f.app.show('revision-initial')).changes, [change]);
  const applied = await f.app.apply('revision-initial');
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.changes, [change]);
  assert.equal((await lstat(f.guidance)).isDirectory(), true);
  assert.equal((await f.app.apply('revision-initial')).status, 'unchanged');
});
test('new required ancestors appear in inspection and partial I/O failure reports', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const parent = join(f.project, 'new-parent'),
    nested = join(parent, 'deeper'),
    target = join(nested, 'prompt.md');
  const artifactPath = resourcePath('worker', '/prompt');
  await f.save('revision-initial', [file(artifactPath, 'saved prompt')], {
    sourceResources: [
      { pointer: '/prompt', kind: 'file', path: target, artifactPath },
    ],
  });
  const shown = await f.app.show('revision-initial');
  assert.deepEqual(
    (shown.changes as JsonObject[])
      .filter((change) => change.kind === 'directory')
      .map((change) => change.path),
    [parent, nested],
  );
  const original = filesystem.rename;
  filesystem.rename = async () => {
    throw new Error('injected write failure after directory creation');
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.app.apply('revision-initial'),
      /completed changes:.*"kind":"directory".*new-parent.*deeper.*injected write failure/,
    );
  } finally {
    filesystem.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal((await lstat(nested)).isDirectory(), true);
  await assert.rejects(readFile(target), /ENOENT/);
  assert.equal((await f.app.apply('revision-initial')).status, 'applied');
  assert.equal(await readFile(target, 'utf8'), 'saved prompt');
  assert.equal((await f.app.apply('revision-initial')).status, 'unchanged');
});
test('directory application handles file/directory transitions and reports repeatable partial I/O failure', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.save('revision-file', [file(f.prefix + '/item', 'one')]);
  await f.save('revision-directory', [
    file(f.prefix + '/item/child.md', 'two'),
  ]);
  await f.app.apply('revision-file');
  await f.app.apply('revision-directory');
  assert.equal(
    await readFile(join(f.guidance, 'item', 'child.md'), 'utf8'),
    'two',
  );
  await f.app.apply('revision-file');
  assert.equal(await readFile(join(f.guidance, 'item'), 'utf8'), 'one');
  await f.save('revision-partial', [
    file(f.prefix + '/a.md', 'a'),
    file(f.prefix + '/b.md', 'b'),
  ]);
  const original = filesystem.rename;
  let renames = 0;
  filesystem.rename = async (source, destination) => {
    if (++renames === 2) throw new Error('injected I/O failure');
    return original(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.app.apply('revision-partial'),
      /completed changes:.*a\.md.*injected I\/O failure/,
    );
  } finally {
    filesystem.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(f.guidance, 'a.md'), 'utf8'), 'a');
  await assert.rejects(readFile(join(f.guidance, 'b.md')), /ENOENT/);
  await f.app.apply('revision-partial');
  assert.equal(await readFile(join(f.guidance, 'b.md'), 'utf8'), 'b');
  assert.equal((await f.app.apply('revision-partial')).status, 'unchanged');
});
test('unresolved and cleanup owners block apply while list/show remain available', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.directory, 'locks', 'initializing.lock'), {
    recursive: true,
  });
  await assert.rejects(f.app.apply('revision-initial'), /initializing/);
  assert.equal((await f.app.list()).length, 1);
  assert.equal(
    (await f.app.show('revision-initial')).applicationAllowed,
    false,
  );
  await rm(join(f.directory, 'locks', 'initializing.lock'), {
    recursive: true,
  });
  await f.facts.write('experiments', 'uncertain', {
    id: 'uncertain',
    status: 'running',
  });
  await assert.rejects(f.app.apply('revision-initial'), /uncertain/);
});
test('separate process startup cannot load a Recipe while source application holds the data-root gate', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const gate = await acquireResourceGate(f.directory);
  const childScript = join(f.root, 'child.mjs');
  await writeFile(
    childScript,
    `import { Manager } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../src/runtime/manager/index.ts', import.meta.url))).href)};\nimport { Registry } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../src/runtime/registry/index.ts', import.meta.url))).href)};\nconst manager = new Manager({ registry: new Registry(), directory: ${JSON.stringify(f.directory)}, rootDirectory: ${JSON.stringify(f.project)} });\nprocess.send('ready');\ntry { await manager.run(${JSON.stringify(join(f.root, 'missing-recipe.yaml'))}); } catch(error) { process.send({done: String(error)}); }\nawait manager.dispose();`,
  );
  const child = fork(childScript, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(messages, ['ready']);
  await gate.release();
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`child exit ${code}`)),
    );
    child.once('error', reject);
  });
  assert.equal(messages.length, 2);
  assert.match(JSON.stringify(messages[1]), /missing-recipe/);
});
test(
  'show holds the source gate until probe cleanup finishes before another process starts an experiment',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await writeFile(join(f.guidance, 'original.md'), 'untouched');
    await f.save('revision-inspect', [
      file(f.prefix + '/a.md', 'a'),
      file(f.prefix + '/b.md', 'b'),
    ]);
    let cleaning!: () => void, resume!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleaning = resolve;
    });
    const cleanupAllowed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalRemove = filesystem.rm;
    filesystem.rm = async (...args) => {
      if (String(args[0]).includes('.rsi-name-check-')) {
        cleaning();
        await cleanupAllowed;
      }
      return originalRemove(...args);
    };
    syncBuiltinESMExports();
    const shown = f.app.show('revision-inspect');
    try {
      await cleanupStarted;
      assert.ok(
        (await readdir(f.guidance)).some((name) =>
          name.startsWith('.rsi-name-check-'),
        ),
      );
      const script = join(f.root, 'start-after-inspection.mjs');
      const source = (path: string): string =>
        pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href;
      await writeFile(
        script,
        `import { Manager } from ${JSON.stringify(source('../../src/runtime/manager/index.ts'))};
import { Registry } from ${JSON.stringify(source('../../src/runtime/registry/index.ts'))};
import { readdir } from 'node:fs/promises';
const registry = new Registry();
const manager = new Manager({ registry, directory: ${JSON.stringify(f.directory)}, rootDirectory: ${JSON.stringify(f.project)} });
process.send('ready');
try { await manager.run(${JSON.stringify(join(f.project, 'missing-recipe.yaml'))}); }
catch (error) { process.send({ done: String(error), entries: await readdir(${JSON.stringify(f.guidance)}) }); }
await manager.dispose(); await registry.dispose();`,
      );
      const child = fork(script, [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      t.after(() => child.kill());
      const messages: unknown[] = [];
      child.on('message', (message) => messages.push(message));
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('message', () => resolve());
          child.once('error', reject);
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(messages, ['ready']);
        resume();
        assert.equal((await shown).applicationAllowed, true);
        assert.equal(await exited, 0);
        assert.equal(messages.length, 2);
        const completed = object(messages[1]);
        assert.match(string(completed.done), /missing-recipe/);
        assert.deepEqual(completed.entries, ['original.md']);
      } finally {
        resume();
        child.kill();
        await exited;
      }
    } finally {
      resume();
      await shown.catch(() => {});
      filesystem.rm = originalRemove;
      syncBuiltinESMExports();
    }
  },
);
test('separate process active and cleaning-up experiments block apply from any origin', async (t) => {
  const f = await fixture();
  const source = (path: string): string =>
    pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href;
  const policy = join(f.project, 'policy.yaml'),
    recipe = join(f.project, 'recipe.yaml');
  await writeFile(
    policy,
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'controlled',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { worker: { contract: 'contract.controlled-worker' } },
      output: {},
      steps: [{ id: 'work', type: 'invoke', use: 'worker', with: {} }],
    }),
  );
  await writeFile(
    recipe,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'controlled',
      application: { plugin: 'controlled.application', config: {} },
      policy: { id: 'controlled', input: {}, config: {} },
      bindings: { worker: { plugin: 'controlled.worker', config: {} } },
      budget: { operations: 10, elapsedWallMs: 30000, cleanupReserveMs: 10000 },
    }),
  );
  const script = join(f.root, 'owner.mjs');
  await writeFile(
    script,
    `import { Manager } from ${JSON.stringify(source('../../src/runtime/manager/index.ts'))};
import { Registry } from ${JSON.stringify(source('../../src/runtime/registry/index.ts'))};
import { applicationContract, defineContract } from ${JSON.stringify(source('../../src/contracts/index.ts'))};
const registry = new Registry();
const wait = (name) => { process.send(name); return new Promise(resolve => process.once('message', resolve)); };
registry.registerOperation({ id: 'controlled.application', contract: applicationContract, configSchema: {type:'object'}, async create(){return {async execute(_input,ctx){return {action:'initialize',target:{},capabilities:[],initialCandidateRef:await ctx.recordCandidate(await ctx.artifacts.putJson({kind:'file-tree',files:[]}),null)}},async dispose(){}}}});
registry.registerOperation({ id: 'controlled.worker', contract: defineContract({ id:'contract.controlled-worker',input_schema:{type:'object'},output_schema:{type:'object'} }),configSchema:{type:'object'},async create(){return {async execute(){await wait('running');return {}},async dispose(){await wait('cleanup')}}}});
registry.registerPolicy('controlled',${JSON.stringify(policy)});
const manager = new Manager({registry,rootDirectory:${JSON.stringify(f.project)},directory:${JSON.stringify(f.directory)}});
await manager.run(${JSON.stringify(recipe)},{id:'active-owner'}); await manager.dispose();await registry.dispose();`,
  );
  const child = fork(script, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    child.kill();
    await rm(f.root, { recursive: true, force: true });
  });
  const next = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('controlled owner timed out')),
        10000,
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`controlled owner exited ${code}`));
      });
    });
  assert.equal(await next(), 'running');
  await assert.rejects(f.app.apply('revision-initial'), /active-owner/);
  assert.equal(
    (await f.app.show('revision-initial')).applicationAllowed,
    false,
  );
  const cleanup = next();
  child.send('complete-work');
  assert.equal(await cleanup, 'cleanup');
  await assert.rejects(f.app.apply('revision-initial'), /active-owner/);
  const exited = new Promise<void>((resolve, reject) =>
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`owner exit ${code}`)),
    ),
  );
  child.send('complete-cleanup');
  await exited;
  await f.app.apply('revision-initial');
  assert.equal(
    await readFile(join(f.guidance, 'original.md'), 'utf8'),
    'original',
  );
});
test('concurrent applications in separate processes serialize through the same source gate', async (t) => {
  const f = await fixture();
  await f.save('revision-next', [file(f.prefix + '/original.md', 'next')]);
  let enter!: () => void, releaseRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const read = f.artifacts.readJson.bind(f.artifacts);
  let first = true;
  f.artifacts.readJson = async (ref) => {
    if (first) {
      first = false;
      enter();
      await waiting;
    }
    return read(ref);
  };
  const applying = f.app.apply('revision-initial');
  await entered;
  const source = (path: string): string =>
    pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href;
  const script = join(f.root, 'apply.mjs');
  await writeFile(
    script,
    `import { RevisionApplication } from ${JSON.stringify(source('../../src/runtime/revisions/application.ts'))};
import { FileArtifacts,FileFacts } from ${JSON.stringify(source('../../src/runtime/storage/index.ts'))};
const application = new RevisionApplication({directory:${JSON.stringify(f.directory)},rootDirectory:${JSON.stringify(f.project)},facts:new FileFacts(${JSON.stringify(join(f.directory, 'facts'))}),artifacts:new FileArtifacts(${JSON.stringify(join(f.directory, 'artifacts'))})});
process.send('ready'); await application.apply('revision-next');process.send('applied');`,
  );
  const child = fork(script, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    releaseRead();
    child.kill();
    await applying.catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  });
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(messages, ['ready']);
  const exited = new Promise<void>((resolve, reject) =>
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`application child exit ${code}`)),
    ),
  );
  releaseRead();
  await applying;
  await exited;
  assert.deepEqual(messages, ['ready', 'applied']);
  assert.equal(await readFile(join(f.guidance, 'original.md'), 'utf8'), 'next');
});
test('a fresh experiment loads and delivers resources explicitly applied from an earlier experiment', async (t) => {
  const f = await fixture();
  const registry = new Registry(),
    manager = new Manager({
      registry,
      directory: f.directory,
      rootDirectory: f.project,
    });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    await rm(f.root, { recursive: true, force: true });
  });
  registry.registerOperation({
    id: 'fresh.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, ctx) {
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await ctx.recordCandidate(
              await ctx.artifacts.putJson({ kind: 'file-tree', files: [] }),
              null,
            ),
          };
        },
        async dispose() {},
      };
    },
  });
  const contract = defineContract({
    id: 'contract.fresh-reader',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  registry.registerOperation({
    id: 'fresh.reader',
    contract,
    configSchema: {
      type: 'object',
      properties: { guidance: { type: 'string', 'x-rsi-path': 'directory' } },
      required: ['guidance'],
    },
    async create(config) {
      return {
        async execute() {
          return {
            delivered: await readFile(
              join(string(config.guidance), 'original.md'),
              'utf8',
            ),
          };
        },
        async dispose() {},
      };
    },
  });
  const policy = join(f.project, 'policy.yaml'),
    recipe = join(f.project, 'recipe.yaml');
  await writeFile(
    policy,
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'fresh',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { reader: { contract: contract.id } },
      output: '${{ steps.read.output }}',
      steps: [{ id: 'read', type: 'invoke', use: 'reader', with: {} }],
    }),
  );
  await writeFile(
    recipe,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'fresh',
      application: { plugin: 'fresh.application', config: {} },
      policy: { id: 'fresh', input: {}, config: {} },
      bindings: {
        reader: { plugin: 'fresh.reader', config: { guidance: './guidance' } },
      },
      budget: { operations: 10, elapsedWallMs: 10000 },
    }),
  );
  registry.registerPolicy('fresh', policy);
  await f.save('revision-delivered', [
    file(f.prefix + '/original.md', 'applied earlier guidance'),
  ]);
  await f.app.apply('revision-delivered');
  const result = await manager.run(recipe, { id: 'fresh-run' });
  assert.equal(result.status, 'succeeded');
  assert.equal(object(result.output).delivered, 'applied earlier guidance');
});
