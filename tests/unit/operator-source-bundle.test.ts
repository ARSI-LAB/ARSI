import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOperatorCase } from '../../src/plugins/evaluator-operatorbench/kernel-input.js';
import { fixedConditions } from '../../src/plugins/evaluator-operatorbench/conditions.js';
import {
  kernelBundleDigest,
  parseKernelExecution,
} from '../../src/plugins/application-kernel/schema.js';

test('SDK staging retains the candidate tree and compares only read-only source contents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'operator-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = 'kernels/problem.py';
  const sources = {
    [sourcePath]:
      'from .tiling import BLOCK\ndef kernel_function(x): return x + BLOCK\n',
    'kernels/tiling.py': 'BLOCK = 0\n',
    'kernels/__init__.py': '',
  };
  const sourceFiles = [];
  for (const [path, content] of Object.entries(sources)) {
    await mkdir(join(root, 'source/kernels'), { recursive: true });
    await writeFile(join(root, 'source', path), content);
    sourceFiles.push({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  const execution = parseKernelExecution({
    kind: 'kernel-source',
    format: 'triton-ascend',
    directory: join(root, 'source'),
    sourcePath,
    sourceFiles,
    artifactRef: 'artifact',
    entryPoint: 'kernel_function',
  });
  const manifest = join(root, 'staged/manifest.json');
  const task = {
    definition: {
      contract: {
        inputs: [{ shape: [4], dtype: 'float16', contiguous: true }],
        output: {
          shape: [4],
          dtype: 'float16',
          contiguous: true,
          independent: true,
        },
        inputUnmodified: true,
      },
    },
    reference: Buffer.from('# reference\n'),
  };
  const options = {
    task,
    selected: { id: 'copy', seed: 42 },
    execution,
    manifest,
    operation: 'evaluate' as const,
    editablePaths: ['kernels/tiling.py'],
  };
  const prepared = await prepareOperatorCase(options);
  const staged = JSON.parse(await readFile(manifest, 'utf8')).tasks[0];
  assert.equal(staged.candidateRoot, 'candidate');
  assert.equal(staged.candidate, 'candidate/' + sourcePath);
  assert.deepEqual(staged.files, [
    'candidate/kernels/__init__.py',
    'candidate/kernels/tiling.py',
  ]);
  for (const [path, content] of Object.entries(sources))
    assert.equal(
      await readFile(join(root, 'staged/candidate', path), 'utf8'),
      content,
    );
  assert.equal(
    await readFile(join(root, 'staged/problem.py'), 'utf8'),
    '# reference\n',
  );
  const files = sourceFiles.map((file) => ({
    ...file,
    path: 'data/candidate/' + file.path,
  }));
  const run = {
    identity: 'sdk',
    pluginVersions: [],
    source: {
      files: [
        { path: 'manifest.json', sha256: 'manifest' },
        { path: 'data/problem.py', sha256: prepared.referenceSha256 },
        ...files,
      ],
    },
  };
  const before = fixedConditions(run, prepared);
  const changed = structuredClone(run);
  const helper = changed.source.files.find((file) =>
    file.path.endsWith('/tiling.py'),
  );
  assert.ok(helper);
  helper.sha256 = 'b'.repeat(64);
  assert.deepEqual(fixedConditions(changed, prepared), before);
  const entry = changed.source.files.find(
    (file) =>
      file.path.endsWith('/problem.py') && file.path.includes('/candidate/'),
  );
  assert.ok(entry);
  entry.sha256 = 'c'.repeat(64);
  assert.notDeepEqual(fixedConditions(changed, prepared), before);
  await writeFile(join(root, 'source/kernels/tiling.py'), 'BLOCK = 1\n');
  await assert.rejects(prepareOperatorCase(options), /digest mismatch/);
});

test('bundle and fixed inventory ordering distinguish byte-distinct Unicode paths deterministically', () => {
  const files = [
    { path: '\u00e9.py', sha256: 'a'.repeat(64) },
    { path: 'e\u0301.py', sha256: 'b'.repeat(64) },
  ];
  assert.equal(
    kernelBundleDigest('\u00e9.py', files),
    kernelBundleDigest('\u00e9.py', [...files].reverse()),
  );
  const prepared = {
    sourceInventory: { entryFile: 'é.py', files, mutablePaths: [] },
  };
  const run = (entries: typeof files) => ({ source: { files: entries } });
  assert.deepEqual(
    fixedConditions(run(files), prepared),
    fixedConditions(run([...files].reverse()), prepared),
  );
  assert.deepEqual(
    fixedConditions(run(files), prepared).fixedFiles.map((file) => file.path),
    ['e\u0301.py', '\u00e9.py'],
  );
});

test('single-file candidates retain their path and read-only identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'operator-single-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'entry.py'), 'def kernel_function(x): return x\n');
  const sha256 = createHash('sha256')
    .update(await readFile(join(root, 'entry.py')))
    .digest('hex');
  const sourceFiles = [{ path: 'entry.py', sha256 }];
  const execution = parseKernelExecution({
    kind: 'kernel-source',
    format: 'triton-ascend',
    directory: root,
    artifactRef: 'artifact',
    sourcePath: 'entry.py',
    sourceFiles,
    entryPoint: 'kernel_function',
  });
  const options = {
    task: {
      definition: {
        contract: {
          inputs: [{ shape: [1], dtype: 'float16', contiguous: true }],
          output: {
            shape: [1],
            dtype: 'float16',
            contiguous: true,
            independent: true,
          },
          inputUnmodified: true,
        },
      },
      reference: Buffer.from('# reference\n'),
    },
    selected: { id: 'fixed', seed: 42 },
    execution,
    manifest: join(root, 'staged/manifest.json'),
    operation: 'evaluate' as const,
  };
  const readonly = await prepareOperatorCase({ ...options, editablePaths: [] });
  assert.deepEqual(readonly.sourceInventory, {
    entryFile: 'entry.py',
    files: sourceFiles,
    mutablePaths: [],
  });
  const run = {
    source: {
      files: [
        { path: 'data/problem.py', sha256: readonly.referenceSha256 },
        { path: 'data/candidate/entry.py', sha256 },
      ],
    },
  };
  const changed = structuredClone(run);
  const changedEntry = changed.source.files[1];
  assert.ok(changedEntry);
  changedEntry.sha256 = 'b'.repeat(64);
  assert.notDeepEqual(
    fixedConditions(run, readonly),
    fixedConditions(changed, readonly),
  );
  const mutable = await prepareOperatorCase({
    ...options,
    editablePaths: ['entry.py'],
  });
  assert.deepEqual(
    fixedConditions(run, mutable),
    fixedConditions(changed, mutable),
  );
  assert.ok(readonly.sourceInventory);
  const otherLayout = {
    sourceInventory: { ...readonly.sourceInventory, entryFile: 'different.py' },
  };
  assert.notDeepEqual(
    fixedConditions(run, readonly),
    fixedConditions(run, otherLayout),
  );
  assert.equal(
    JSON.parse(await readFile(options.manifest, 'utf8')).tasks[0].candidate,
    'candidate/entry.py',
  );
});
