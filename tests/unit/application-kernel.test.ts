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
  '# UTF-8 source: 算子\ndef kernel_function(x):\n    return x\n';
const target: JsonObject = {
  schemaVersion: 'rsi.target/v1',
  id: 'kernel',
  entries: [
    {
      path: 'input.py',
      kind: 'file',
      description: 'Triton Ascend operator source',
      changes: ['modify'],
      content: { encoding: 'utf-8' },
    },
  ],
  protected: ['problem.py'],
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-application-kernel-'));
  t.after(async () => {
    try {
      await application.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const baseline = join(root, 'baseline');
  await mkdir(baseline);
  await writeFile(join(baseline, 'input.py'), baselineSource);
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
    target: { schema: target },
    baseline: { directory: baseline },
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
  assert.equal(execution.entryPoint, 'kernel_function');
  assert.equal(execution.format, 'triton-ascend');
  assert.equal(execution.kind, 'kernel-source');
  assert.equal(
    execution.sourceDigest,
    createHash('sha256')
      .update(Buffer.from(baselineSource, 'utf8'))
      .digest('hex'),
  );
  assert.equal(
    await readFile(join(execution.directory, 'input.py'), 'utf8'),
    baselineSource,
  );
  const materialized = await context.workspaces.create(execution.artifactRef);
  assert.deepEqual(
    await readFile(join(materialized.directory, 'input.py')),
    await readFile(join(execution.directory, 'input.py')),
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
  await assert.rejects(readFile(join(execution.directory, 'input.py')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readdir(context.workspaces.directory), []);
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
  await writeFile(join(edit.directory, 'input.py'), defectiveSource);
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
    await readFile(join(execution.directory, 'input.py'), 'utf8'),
    defectiveSource,
  );
  assert.equal(
    execution.sourceDigest,
    createHash('sha256').update(defectiveSource).digest('hex'),
  );
  await context.workspaces.release(edit.ref);
});

test('kernel commit rejects edits outside Target and missing structural entry without creating candidates', async (t) => {
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
  await writeFile(
    join(edit.directory, 'input.py'),
    '# def kernel_function(x):\ndef wrong_entry(x):\n    return x\n',
  );
  await assert.rejects(application.execute(commit, context), /kernel_function/);
  assert.equal((await context.facts.list('candidates')).length, 1);
  await context.workspaces.release(edit.ref);
});

test('kernel initialize rejects absent source and invalid UTF-8 before recording candidates', async (t) => {
  const { baseline, context, application } = await fixture(t);
  const before = (await context.facts.list('candidates')).length;
  await rm(join(baseline, 'input.py'));
  await assert.rejects(
    application.execute({ action: 'initialize' }, context),
    /input.py/,
  );
  await writeFile(join(baseline, 'input.py'), Buffer.from([0xff, 0xfe]));
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

test('kernel execution parsing checks fixed format, digest, and helper-provided artifact identity', () => {
  const execution = {
    kind: 'kernel-source',
    format: 'triton-ascend',
    directory: '/leased/source',
    artifactRef: 'artifact',
    sourceDigest: 'a'.repeat(64),
    entryPoint: 'kernel_function',
    workspaceRef: 'workspace',
    artifactDigest: 'artifact',
  };
  assert.deepEqual(parseKernelExecution(execution), execution);
  for (const invalid of [
    { ...execution, format: 'python' },
    { ...execution, sourceDigest: 'bad-digest' },
    { ...execution, entryPoint: 'wrong_entry' },
    { ...execution, artifactDigest: 'different-artifact' },
    { ...execution, unexpected: true },
  ])
    assert.throws(
      () => parseKernelExecution(invalid),
      /KernelExecution|artifact/,
    );
  assert.equal(
    object(parseKernelExecution(execution)).sourceDigest,
    execution.sourceDigest,
  );
});
