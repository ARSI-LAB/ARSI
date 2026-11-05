import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type Candidate,
  type JsonObject,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import {
  FileArtifacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { createFileApplication } from '../../src/plugins/shared/file-application/files.js';
import { createProposerAgent } from '../../src/plugins/proposer-agent/service.js';
import { resourceFiles } from '../../src/plugins/shared/agent-editing/index.js';

async function fixture(responses: JsonObject[], patch = false) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-proposer-recovery-'));
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const workspaces = new FileWorkspaces(join(root, 'workspaces'), artifacts);
  const initial = {
    'skill.md': 'one\nmiddle\nthree\n',
    'other.md': 'original',
  };
  const base = await artifacts.putJson({
    kind: 'file-tree',
    files: Object.entries(initial).map(([path, content]) => ({
      path,
      mode: 420,
      base64: Buffer.from(content).toString('base64'),
    })),
  });
  const candidates = new Map<string, Candidate>([
    [
      'base',
      { ref: 'base', parentRef: null, artifactRef: base, experimentId: 'exp' },
    ],
  ]);
  const target = {
    schemaVersion: 'rsi.target/v1',
    id: 'edit-recovery',
    entries: [...Object.keys(initial), 'new.md'].map((path) => ({
      path,
      kind: 'file',
      description: 'editable instructions',
      changes: ['create', 'modify', 'delete'],
      content: { encoding: 'utf-8', maxBytes: 131072 },
    })),
  };
  const controller = new AbortController();
  let requests = 0;
  let commits = 0;
  const context = new RuntimeContext().extend({
    experimentId: 'exp',
    callId: 'call',
    bindingId: 'composer',
    idempotencyKey: 'call',
    directory: root,
    rootDirectory: root,
    dataDirectory: root,
    signal: controller.signal,
    cleanup: new AbortController().signal,
    artifacts,
    workspaces,
    readCandidate: async (ref) => {
      const candidate = candidates.get(ref);
      assert.ok(candidate);
      return candidate;
    },
    recordCandidate: async (artifactRef, parentRef) => {
      const ref = `candidate-${candidates.size}`;
      candidates.set(ref, { ref, artifactRef, parentRef, experimentId: 'exp' });
      return ref;
    },
    applicationMetadata: async () => ({ target }),
    readEvidence: async () => ({}),
    invokeAgent: async () => {
      const result = responses[requests++];
      assert.ok(result, 'no unexpected model retry');
      return result;
    },
  });
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected backend call');
  };
  const application = await createFileApplication(
    { target: { schema: target }, baseline: { artifactRef: base } },
    context,
    {
      capability: 'test',
      verify: async (directory) => {
        await readFile(join(directory, 'skill.md'), 'utf8');
        return {};
      },
      acquire: unused,
      release: unused,
      dispose: async () => {},
    },
  );
  const execution = context.extend({
    application: async (input) => {
      assert.equal(input.action, 'commit');
      commits++;
      return application.execute(
        {
          action: 'commit',
          parentCandidateRef: String(input.parentCandidateRef),
          editRef: String(input.editRef),
          ...(input.editConstraints
            ? { editConstraints: object(input.editConstraints) }
            : {}),
        },
        context,
      );
    },
  });
  const proposer = await createProposerAgent(
    {
      prompt: 'src/policies/harness2/prompts/compose.md',
      evidenceView: 'training-summary',
      ...(patch ? { editProtocol: 'patch' } : {}),
    },
    execution,
  );
  return {
    root,
    initial,
    execution,
    controller,
    requests: () => requests,
    commits: () => commits,
    execute: (editConstraints?: JsonObject) =>
      proposer.execute(
        {
          parent: 'base',
          goal: 'Improve instructions',
          evidenceRefs: [],
          ...(editConstraints ? { editConstraints } : {}),
        },
        execution,
      ),
    close: async () => {
      await proposer.dispose();
      await application.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Composer conflict retains the whole parent and the next proposal can commit', async () => {
  const f = await fixture([
    {
      edits: [
        { path: 'other.md', content: 'must not be applied' },
        { path: 'skill.md', content: 'changed' },
        { path: 'skill.md', content: null },
      ],
      reason: 'Compose changes',
    },
    {
      edits: [{ path: 'skill.md', content: 'next proposal' }],
      reason: 'Continue',
    },
  ]);
  try {
    const result = object(await f.execute());
    assert.equal(result.status, 'no-change');
    assert.equal(result.candidateRef, 'base');
    assert.equal(result.diffRef, null);
    assert.match(String(result.rationale), /conflict|merge/i);
    const parent = await f.execution.readCandidate('base');
    assert.deepEqual(
      await resourceFiles(parent.artifactRef, f.execution),
      f.initial,
    );
    assert.deepEqual(await readdir(join(f.root, 'workspaces')), []);
    const next = object(await f.execute());
    assert.equal(next.status, 'created');
    const candidate = await f.execution.readCandidate(
      String(next.candidateRef),
    );
    assert.deepEqual(await resourceFiles(candidate.artifactRef, f.execution), {
      'skill.md': 'next proposal',
      'other.md': 'original',
    });
    assert.equal(f.requests(), 2);
    assert.deepEqual(await readdir(join(f.root, 'workspaces')), []);
  } finally {
    await f.close();
  }
});

test('Composer merges duplicate paths before committing through the Application', async () => {
  const f = await fixture([
    {
      edits: [
        { path: 'skill.md', content: 'ONE\nmiddle\nthree\n' },
        { path: 'skill.md', content: 'one\nmiddle\nTHREE\n' },
      ],
      reason: 'Independent improvements',
    },
  ]);
  try {
    const result = object(await f.execute());
    assert.equal(result.status, 'created');
    const candidate = await f.execution.readCandidate(
      String(result.candidateRef),
    );
    assert.equal(
      (await resourceFiles(candidate.artifactRef, f.execution))['skill.md'],
      'ONE\nmiddle\nTHREE\n',
    );
  } finally {
    await f.close();
  }
});

test('Composer does not disguise unauthorized edits or cancellation as merge fallback', async () => {
  const response = {
    edits: [
      { path: 'other.md', content: 'unauthorized' },
      { path: 'skill.md', content: 'changed' },
      { path: 'skill.md', content: null },
    ],
    reason: 'Invalid scope',
  };
  const f = await fixture([response, response]);
  try {
    await assert.rejects(
      f.execute({ allowedPaths: ['skill.md'] }),
      /authorized/,
    );
    f.controller.abort(new Error('cancelled by caller'));
    await assert.rejects(f.execute(), /cancelled by caller/);
    assert.deepEqual(await readdir(join(f.root, 'workspaces')), []);
  } finally {
    await f.close();
  }
});

test('patch hunks use the original file and commit together with creation and deletion', async () => {
  const f = await fixture(
    [
      {
        edits: [
          {
            op: 'patch',
            path: 'skill.md',
            changes: [
              { oldText: 'one', newText: 'one three' },
              { oldText: 'three', newText: 'THREE' },
            ],
          },
          { op: 'create', path: 'new.md', content: '' },
          { op: 'delete', path: 'other.md' },
        ],
        reason: 'Revise instructions',
      },
    ],
    true,
  );
  try {
    const result = await f.execute();
    assert.equal(result.status, 'created');
    const candidate = await f.execution.readCandidate(result.candidateRef);
    assert.deepEqual(await resourceFiles(candidate.artifactRef, f.execution), {
      'skill.md': 'one three\nmiddle\nTHREE\n',
      'new.md': '',
    });
  } finally {
    await f.close();
  }
});

test('an ambiguous patch prevents the whole batch from being submitted', async () => {
  const f = await fixture(
    [
      {
        edits: [
          { op: 'create', path: 'new.md', content: 'uncommitted' },
          {
            op: 'patch',
            path: 'skill.md',
            changes: [{ oldText: 'e', newText: '' }],
          },
        ],
        reason: 'Invalid edit batch',
      },
    ],
    true,
  );
  try {
    await assert.rejects(f.execute(), /skill.md.*ambiguous/);
    assert.equal(f.commits(), 0);
    const parent = await f.execution.readCandidate('base');
    assert.deepEqual(
      await resourceFiles(parent.artifactRef, f.execution),
      f.initial,
    );
  } finally {
    await f.close();
  }
});
