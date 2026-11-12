import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import {
  RuntimeContext,
  type Candidate,
  type JsonObject,
} from '../../src/contracts/index.js';
import {
  parseKernelExecution,
  kernelExecutionSchema,
  kernelSourcePath,
} from '../../src/plugins/application-kernel/schema.js';
import {
  createApplicationKernel,
  kernelApplicationDefinition,
} from '../../src/plugins/application-kernel/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { object, string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

const baselineSource =
  '# UTF-8 source: operator \u03bb\ndef kernel_function(x):\n    return x\n';
const sourcePath = 'kernels/transpose_kernel.py';
const target: JsonObject = {
  schemaVersion: 'rsi.target/v1',
  id: 'kernel',
  entries: [
    {
      path: sourcePath,
      kind: 'file',
      description: 'Triton Ascend operator source',
      changes: ['modify'],
      content: { encoding: 'utf-8' },
    },
  ],
  protected: ['problem.py'],
};

async function fixture(
  t: TestContext,
  options: {
    entryFile?: string;
    target?: JsonObject;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-application-kernel-'));
  t.after(async () => {
    try {
      await application.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const baseline = join(root, 'baseline');
  await mkdir(join(baseline, 'kernels'), { recursive: true });
  await writeFile(join(baseline, sourcePath), baselineSource);
  await writeFile(join(baseline, 'kernels/tiling.py'), 'BLOCK = 32\n');
  await writeFile(join(baseline, 'kernels/__init__.py'), '');
  await writeFile(join(baseline, 'problem.py'), '# protected reference\n');
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const facts = new FileFacts(join(root, '.rsi/facts'));
  const workspaces = new FileWorkspaces(
    join(root, '.rsi/workspaces'),
    artifacts,
  );
  const context = new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    experimentId: 'kernel-experiment',
    callId: 'kernel-call',
    bindingId: 'application',
    idempotencyKey: 'kernel-call',
    directory: join(root, '.rsi/calls/kernel-call'),
    signal: new AbortController().signal,
    cleanup: AbortSignal.timeout(5000),
    artifacts,
    facts,
    workspaces,
    async readCandidate(ref: string): Promise<Candidate> {
      const value = await facts.read('candidates', ref);
      return {
        ref,
        artifactRef: string(value.artifactRef),
        parentRef: value.parentRef === null ? null : string(value.parentRef),
        experimentId: string(value.experimentId),
      };
    },
    async recordCandidate(
      this: RuntimeContext,
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string> {
      const ref = `candidate-${(await facts.list('candidates')).length}`;
      await facts.write('candidates', ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
  });
  const config = {
    target: { schema: options.target ?? target },
    baseline: { directory: baseline },
    entryFile: options.entryFile ?? sourcePath,
  };
  const application = await createApplicationKernel(config, context);
  const initial = await application.execute({ action: 'initialize' }, context);
  assert.ok(initial.action === 'initialize');
  return { root, baseline, config, context, application, initial };
}

test('kernel source leases preserve artifact identity and raw UTF-8 bytes until release', async (t) => {
  const { context, application, initial } = await fixture(t);
  assert.equal(kernelApplicationDefinition.contract.id, 'contract.application');
  assert.deepEqual(initial.capabilities, ['kernel-source']);
  const candidate = await context.readCandidate(initial.initialCandidateRef);
  const input = {
    action: 'acquire',
    candidateRef: candidate.ref,
    instanceId: 'source-lease',
    capability: 'kernel-source',
  } as const;
  const acquired = await application.execute(input, context);
  assert.ok(acquired.action === 'acquire');
  const execution = parseKernelExecution(acquired.execution);
  validate(kernelExecutionSchema, acquired.execution);
  assert.equal(execution.artifactRef, candidate.artifactRef);
  assert.equal(execution.sourcePath, sourcePath);
  assert.equal(execution.entryPoint, 'kernel_function');
  assert.equal(execution.format, 'triton-ascend');
  assert.equal(execution.kind, 'kernel-source');
  assert.equal(
    execution.sourceFiles.find((file) => file.path === sourcePath)?.sha256,
    createHash('sha256')
      .update(Buffer.from(baselineSource, 'utf8'))
      .digest('hex'),
  );
  assert.equal(
    await readFile(join(execution.directory, sourcePath), 'utf8'),
    baselineSource,
  );
  const materialized = await context.workspaces.create(execution.artifactRef);
  assert.deepEqual(
    await readFile(join(materialized.directory, sourcePath)),
    await readFile(join(execution.directory, sourcePath)),
  );
  await context.workspaces.release(materialized.ref);
  assert.deepEqual(await application.execute(input, context), acquired);
  const released = await application.execute(
    { action: 'release', instanceId: 'source-lease' },
    context,
  );
  assert.deepEqual(
    await application.execute(
      { action: 'release', instanceId: 'source-lease' },
      context,
    ),
    released,
  );
  await assert.rejects(readFile(join(execution.directory, sourcePath)), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readdir(context.workspaces.directory), []);
});

test('kernel bundle supports a read-only entry and helper-only edits', async (t) => {
  const helper = 'kernels/tiling.py';
  const { application, context, initial } = await fixture(t, {
    entryFile: sourcePath,
    target: {
      ...target,
      entries: [
        {
          path: helper,
          kind: 'file',
          description: 'tiling',
          changes: ['modify'],
        },
      ],
    },
  });
  assert.equal(object(initial).capabilityMetadata, undefined);
  async function acquire(candidateRef: string, instanceId: string) {
    const result = await application.execute(
      {
        action: 'acquire',
        candidateRef,
        instanceId,
        capability: 'kernel-source',
      },
      context,
    );
    assert.equal(result.action, 'acquire');
    if (result.action !== 'acquire') throw new Error('acquire failed');
    return parseKernelExecution(result.execution);
  }
  const before = await acquire(initial.initialCandidateRef, 'before');
  assert.deepEqual(
    before.sourceFiles.map((file) => file.path),
    ['kernels/__init__.py', helper, sourcePath, 'problem.py'].sort(),
  );
  const parent = await context.readCandidate(initial.initialCandidateRef);
  const edit = await context.workspaces.create(parent.artifactRef, parent.ref);
  t.after(() => context.workspaces.release(edit.ref));
  await writeFile(join(edit.directory, helper), 'BLOCK = 64\n');
  const result = await application.execute(
    { action: 'commit', parentCandidateRef: parent.ref, editRef: edit.ref },
    context,
  );
  assert.equal(result.action, 'commit');
  if (result.action !== 'commit') throw new Error('commit failed');
  const after = await acquire(result.candidateRef, 'after');
  assert.deepEqual(
    before.sourceFiles.find((f) => f.path === sourcePath),
    after.sourceFiles.find((f) => f.path === sourcePath),
  );
  assert.notDeepEqual(
    before.sourceFiles.find((f) => f.path === helper),
    after.sourceFiles.find((f) => f.path === helper),
  );
  await writeFile(join(edit.directory, sourcePath), '# unauthorized\n');
  await assert.rejects(
    application.execute(
      { action: 'commit', parentCandidateRef: parent.ref, editRef: edit.ref },
      context,
    ),
    /authorized/,
  );
  assert.equal((await context.facts.list('candidates')).length, 2);
});

test('kernel bundle requires its entry and retains the baseline file set', async (t) => {
  const { application, baseline, context, initial } = await fixture(t, {
    entryFile: sourcePath,
    target: {
      ...target,
      entries: [
        {
          path: 'kernels',
          kind: 'directory',
          description: 'sources',
          changes: ['modify', 'create', 'delete'],
        },
      ],
    },
  });
  await rm(join(baseline, sourcePath));
  await assert.rejects(
    application.execute({ action: 'initialize' }, context),
    /transpose_kernel.py/,
  );
  const parent = await context.readCandidate(initial.initialCandidateRef);
  const edit = await context.workspaces.create(parent.artifactRef, parent.ref);
  t.after(() => context.workspaces.release(edit.ref));
  await writeFile(join(edit.directory, 'kernels/new.py'), 'VALUE = 1\n');
  await assert.rejects(
    application.execute(
      { action: 'commit', parentCandidateRef: parent.ref, editRef: edit.ref },
      context,
    ),
    /inventory/,
  );
  await rm(join(edit.directory, 'kernels/new.py'));
  await rm(join(edit.directory, 'kernels/tiling.py'));
  await assert.rejects(
    application.execute(
      { action: 'commit', parentCandidateRef: parent.ref, editRef: edit.ref },
      context,
    ),
    /inventory/,
  );
  assert.equal((await context.facts.list('candidates')).length, 1);
});

test('kernel commits preserve defective source for feedback and reuse unchanged candidates', async (t) => {
  const { context, application, initial } = await fixture(t);
  const parent = await context.readCandidate(initial.initialCandidateRef);
  const edit = await context.workspaces.create(parent.artifactRef, parent.ref);
  const commit = {
    action: 'commit',
    parentCandidateRef: parent.ref,
    editRef: edit.ref,
  } as const;
  assert.deepEqual(await application.execute(commit, context), {
    action: 'commit',
    status: 'no-change',
    candidateRef: parent.ref,
    diffRef: null,
  });
  assert.equal((await context.facts.list('candidates')).length, 1);
  const defectiveSource = 'def kernel_function(x):\n    return (\n';
  await writeFile(join(edit.directory, sourcePath), defectiveSource);
  const result = await application.execute(commit, context);
  assert.ok(result.action === 'commit' && result.status === 'created');
  assert.notEqual(result.candidateRef, parent.ref);
  assert.ok(result.diffRef);
  assert.equal(
    (await context.readCandidate(result.candidateRef)).parentRef,
    parent.ref,
  );
  const acquired = await application.execute(
    {
      action: 'acquire',
      candidateRef: result.candidateRef,
      instanceId: 'defective-source',
      capability: 'kernel-source',
    },
    context,
  );
  assert.ok(acquired.action === 'acquire');
  const execution = parseKernelExecution(acquired.execution);
  assert.equal(
    await readFile(join(execution.directory, sourcePath), 'utf8'),
    defectiveSource,
  );
  assert.equal(
    execution.sourceFiles.find((file) => file.path === sourcePath)?.sha256,
    createHash('sha256').update(defectiveSource).digest('hex'),
  );
  await context.workspaces.release(edit.ref);
});

test('kernel commit enforces the Target and accepts a callable Python alias', async (t) => {
  const { context, application, initial } = await fixture(t);
  const parent = await context.readCandidate(initial.initialCandidateRef);
  const edit = await context.workspaces.create(parent.artifactRef, parent.ref);
  const commit = {
    action: 'commit',
    parentCandidateRef: parent.ref,
    editRef: edit.ref,
  } as const;
  await writeFile(join(edit.directory, 'problem.py'), '# altered reference\n');
  await assert.rejects(
    application.execute(commit, context),
    /protected|authorized/,
  );
  await writeFile(
    join(edit.directory, 'problem.py'),
    '# protected reference\n',
  );
  assert.equal((await context.facts.list('candidates')).length, 1);
  await writeFile(
    join(edit.directory, sourcePath),
    'def transform(x):\n    return x\nkernel_function = transform\n',
  );
  const committed = await application.execute(commit, context);
  assert.ok(committed.action === 'commit' && committed.status === 'created');
  await context.workspaces.release(edit.ref);
});

test('kernel initialize rejects absent source and invalid UTF-8 before recording candidates', async (t) => {
  const { baseline, context, application } = await fixture(t);
  const before = (await context.facts.list('candidates')).length;
  await rm(join(baseline, sourcePath));
  await assert.rejects(
    application.execute({ action: 'initialize' }, context),
    /transpose_kernel\.py/,
  );
  await writeFile(join(baseline, sourcePath), Buffer.from([0xff, 0xfe]));
  await assert.rejects(
    application.execute({ action: 'initialize' }, context),
    /UTF-8|encoded data/,
  );
  assert.equal((await context.facts.list('candidates')).length, before);
});

test('cancelled kernel acquisition removes its materialized workspace and supports repeated release', async (t) => {
  const { context, application, initial } = await fixture(t);
  const controller = new AbortController();
  const createWorkspace = context.workspaces.create.bind(context.workspaces);
  context.workspaces.create = async (...args) => {
    const workspace = await createWorkspace(...args);
    controller.abort(new Error('cancelled after materialization'));
    return workspace;
  };
  await assert.rejects(
    application.execute(
      {
        action: 'acquire',
        candidateRef: initial.initialCandidateRef,
        instanceId: 'cancelled-source',
        capability: 'kernel-source',
      },
      context.extend({ signal: controller.signal }),
    ),
    /cancelled after materialization/,
  );
  assert.deepEqual(await readdir(context.workspaces.directory), []);
  assert.equal(
    (await context.facts.read('instances', 'cancelled-source')).status,
    'released',
  );
  await application.execute(
    { action: 'release', instanceId: 'cancelled-source' },
    context,
  );
  await application.execute(
    { action: 'release', instanceId: 'cancelled-source' },
    context,
  );
  assert.deepEqual(await readdir(context.workspaces.directory), []);
});

test('kernel configuration requires an explicit safe entry path', () => {
  assert.throws(
    () =>
      validate(kernelApplicationDefinition.configSchema, {
        target: { schema: target },
        baseline: { directory: '.' },
      }),
    /entryFile/,
  );
  for (const entryFile of [
    '../helper.py',
    'C:/helper.py',
    'dir/',
    'dir//helper.py',
  ])
    assert.throws(() => kernelSourcePath(entryFile), /path/);
});
test('kernel execution reads only the current source inventory and requires one safe entry', () => {
  const entry = { path: sourcePath, sha256: 'a'.repeat(64) };
  const execution = {
    kind: 'kernel-source',
    format: 'triton-ascend',
    directory: '/leased/source',
    sourcePath,
    sourceFiles: [entry],
    artifactRef: 'artifact',
    entryPoint: 'kernel_function',
    workspaceRef: 'workspace',
    artifactDigest: 'artifact',
  };
  assert.deepEqual(parseKernelExecution(execution), execution);
  const { sourcePath: _path, ...withoutEntry } = execution;
  const { sourceFiles: _files, ...withoutInventory } = execution;
  for (const invalid of [
    withoutEntry,
    withoutInventory,
    { ...withoutInventory, sourceDigest: entry.sha256 },
    { ...execution, sourceDigest: entry.sha256 },
    { ...execution, sourceBundleDigest: entry.sha256 },
    { ...execution, sourceFiles: [] },
    {
      ...execution,
      sourceFiles: [entry, { ...entry, sha256: 'b'.repeat(64) }],
    },
    { ...execution, sourcePath: 'absent.py' },
    { ...execution, sourceFiles: [{ ...entry, sha256: 'bad' }] },
    { ...execution, format: 'python' },
    { ...execution, entryPoint: 'wrong_entry' },
    { ...execution, artifactDigest: 'different-artifact' },
    { ...execution, unexpected: true },
  ])
    assert.throws(() => parseKernelExecution(invalid), /KernelExecution/);
  for (const path of [
    '../secret',
    '/tmp/file',
    './file',
    'dir//file',
    'C:/file',
    'C:file',
    'dir\\file',
    'dir/',
  ]) {
    assert.throws(
      () =>
        parseKernelExecution({
          ...execution,
          sourceFiles: [entry, { ...entry, path }],
        }),
      /path|sourcePath/,
    );
  }
});
