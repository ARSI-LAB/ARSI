import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { collectReflectionEvidence } from '../../src/runtime/revisions/evidence.js';
import { object, string } from '../../src/shared/json.js';
import { createReflectionAgent } from '../../src/plugins/reflection-agent/service.js';
import { readVirtualFile } from '../../src/plugins/agent-pi/service.js';

const at = (second: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-reflection-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const facts = new FileFacts(join(root, 'facts'));
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    facts,
    artifacts,
  });
  const call = async (
    id: string,
    binding: string,
    second: number,
    extra: JsonObject = {},
  ) => {
    await facts.write('calls', id, {
      callId: id,
      bindingId: binding,
      experimentId: context.experimentId,
      parentCallId: 'root',
      path: `loop/0/work/${id}`,
      input: { taskId: 'task' },
      output: { reason: 'useful observation' },
      status: 'succeeded',
      finishedAt: at(second),
      ...extra,
    });
  };
  const collect = async (
    id: string,
    second: number,
    extra: Partial<Parameters<typeof collectReflectionEvidence>[0]> = {},
  ) => {
    const result = await collectReflectionEvidence({
      context,
      names: ['proposer'],
      identity: id,
      capturedAt: at(second),
      policyScopeId: 'root',
      moduleKey: 'module',
      directory: root,
      isAgentBinding: (binding) => binding === 'agent',
      ...extra,
    });
    return {
      result,
      snapshot: await facts.read('evidence-views', string(result.ref)),
    };
  };
  return { root, facts, artifacts, context, call, collect };
}

test('Reflection respects the supplied evidence byte limit and reports omitted content', async (t) => {
  const f = await fixture(t);
  await f.call('large', 'proposer', 1, {
    output: { reason: 'x'.repeat(4096) + 'END_OF_OBSERVATION' },
  });
  const { result, snapshot } = await f.collect('bounded', 2, { maxBytes: 256 });
  assert.deepEqual(result.callIds, ['large']);
  const content = string(
    object(snapshot.files)['context/reflection/calls/large.json'],
  );
  assert.match(content, /truncated: Reflection evidence byte limit/);
  assert.doesNotMatch(content, /END_OF_OBSERVATION/);
  assert.ok(Buffer.byteLength(content) < 512);
  assert.ok(
    Object.values(object(snapshot.files)).reduce<number>(
      (sum, file) =>
        sum + (typeof file === 'string' ? Buffer.byteLength(file) : 0),
      0,
    ) <= 256,
  );
  assert.match(
    JSON.stringify(object(snapshot.index).diagnostics),
    /virtual-file-truncated/,
  );
});

test('Reflection retains deep observations and all relationships without fixed metadata limits', async (t) => {
  const f = await fixture(t);
  let nested: JsonObject = {
    text: 'DEEP_OBSERVATION_END',
    feedback: 'PRIVATE_FEEDBACK',
  };
  for (let index = 0; index < 96; index++) nested = { next: nested };
  await f.call('deep', 'proposer', 1, {
    input: {
      sources: Array.from({ length: 130 }, (_, index) => ({
        candidateRef: `candidate-${index}`,
      })),
    },
    output: nested,
  });
  const { snapshot } = await f.collect('unbounded', 2);
  const content = JSON.stringify(snapshot);
  assert.match(content, /DEEP_OBSERVATION_END/);
  assert.doesNotMatch(content, /PRIVATE_FEEDBACK|omitted-depth-or-size/);
  const entry = (object(snapshot.index).calls as JsonObject[]).find(
    (call) => call.callId === 'deep',
  )!;
  assert.equal(
    (object(entry.relationships).sources as JsonObject[]).length,
    130,
  );
});

test('trigger windows use finish time, retain failure/unknown status, and recover the same snapshot', async (t) => {
  const f = await fixture(t);
  await f.call('first', 'proposer', 1);
  await f.call('at-boundary', 'proposer', 2, {
    status: 'failed',
    error: 'bounded error',
  });
  await f.call('still-running', 'proposer', 1, { status: 'running' });
  await f.call('foreign-binding', 'other', 1, {
    output: { text: 'unselected-secret-marker' },
  });
  const first = await f.collect('r1', 2);
  assert.deepEqual(first.result.callIds, ['first', 'at-boundary']);
  assert.equal(
    JSON.stringify(first.snapshot).includes('unselected-secret-marker'),
    false,
  );
  await f.call('still-running', 'proposer', 3, { status: 'cancelled' });
  await f.call('unknown', 'proposer', 4, {
    status: 'unknown',
    error: 'outcome not confirmed',
  });
  const second = await f.collect('r2', 4);
  assert.deepEqual(second.result.callIds, ['still-running', 'unknown']);
  assert.equal(second.snapshot.windowStart, at(2));
  const frozen = await f.collect('r2', 99, {
    priorRef: string(second.result.ref),
  });
  assert.deepEqual(frozen, second);
  assert.deepEqual((await f.collect('r3', 4)).result.callIds, []);
  const isolated = await f.collect('scope', 4, {
    policyScopeId: 'unrelated-scope',
  });
  assert.deepEqual(isolated.result.callIds, []);
});

test('the same qualified binding in separate Policy executions does not share observations or windows', async (t) => {
  const f = await fixture(t);
  await f.call('scope-a', 'child', 0, { status: 'running' });
  await f.call('scope-b', 'child', 0, { status: 'running' });
  await f.call('a-work', 'child.worker', 1, { parentCallId: 'scope-a' });
  await f.call('b-work', 'child.worker', 2, { parentCallId: 'scope-b' });
  const a = await f.collect('a1', 3, {
    names: ['child.worker'],
    policyScopeId: 'scope-a',
  });
  const b = await f.collect('b1', 3, {
    names: ['child.worker'],
    policyScopeId: 'scope-b',
  });
  assert.deepEqual(a.result.callIds, ['a-work']);
  assert.deepEqual(b.result.callIds, ['b-work']);
  assert.equal(b.snapshot.windowStart, null);
});

test('late associated results are narrowly attributable, deduplicated and usable without new primary calls', async (t) => {
  const f = await fixture(t);
  await f.call('proposal', 'proposer', 1, {
    input: { parent: 'base', taskId: 'task' },
    output: { candidateRef: 'candidate' },
  });
  const first = await f.collect('r1', 2);
  assert.equal(first.result.callCount, 1);
  await f.call('late-eval', 'evaluator', 3, {
    input: { candidateRef: 'candidate' },
    output: {},
    status: 'failed',
    error: 'evaluation failed before measurement',
  });
  await f.call('future-eval', 'evaluator', 8, {
    input: { candidateRef: 'candidate' },
    output: {},
  });
  const second = await f.collect('r2', 4);
  assert.deepEqual(second.result.callIds, []);
  assert.equal(second.result.callCount, 1);
  assert.deepEqual(
    (object(second.snapshot.index).lateResults as JsonObject[]).map(
      (entry) => entry.callId,
    ),
    ['late-eval'],
  );
  assert.equal(JSON.stringify(second.snapshot).includes('future-eval'), false);
  const third = await f.collect('r3', 5);
  assert.equal(third.result.callCount, 0);
  await f.call('ambiguous-producer', 'otherProposer', 6, {
    input: { parent: 'base' },
    output: { candidateRef: 'candidate' },
  });
  const fourth = await f.collect('r4', 9);
  assert.equal(fourth.result.callCount, 0);
  assert.ok(
    (object(fourth.snapshot.index).diagnostics as JsonObject[]).some(
      (entry) => entry.code === 'ambiguous-candidate-result',
    ),
  );
});

test('actual request, diagnostic trace and patch files are readable and scoring fields are projected out', async (t) => {
  const f = await fixture(t);
  const patch = await f.artifacts.putJson({
    text: '--- before\n+++ after\n+useful actual patch',
  });
  await f.call('proposal', 'proposer', 2, {
    input: { parent: 'base', goal: 'inspect sources', scores: { hidden: 42 } },
    output: {
      candidateRef: 'candidate',
      diffRef: patch,
      rationale: 'observed scope',
      gradingDiagnostics: 'private grading marker',
    },
  });
  await f.call('agent', 'agent', 1, {
    parentCallId: 'proposal',
    input: { prompt: 'actual agent prompt', privateAnswer: 'hidden answer' },
    output: { edits: [] },
  });
  const callDirectory = join(f.root, 'experiments/experiment/calls/agent');
  await mkdir(callDirectory, { recursive: true });
  await writeFile(
    join(callDirectory, 'diagnostics.jsonl'),
    JSON.stringify({
      event: 'read_file',
      path: 'source.md',
      scores: { forbidden: 'grading trace marker' },
    }),
  );
  const { snapshot } = await f.collect('r1', 3);
  const files = object(snapshot.files);
  assert.match(
    string(files['context/reflection/calls/proposal-descendant-agent.json']),
    /actual agent prompt/,
  );
  assert.match(
    string(files['context/reflection/calls/proposal-trace-agent.jsonl']),
    /read_file/,
  );
  assert.match(
    string(files['context/reflection/calls/proposal-patch.json']),
    /useful actual patch/,
  );
  const delivered = JSON.stringify(files);
  assert.equal(delivered.includes('private grading marker'), false);
  assert.equal(delivered.includes('grading trace marker'), false);
  assert.equal(delivered.includes('hidden answer'), false);
});

test('Memory snapshots are explicit, decoded and source-referenced', async (t) => {
  const f = await fixture(t);
  const memoryRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'experience.md',
        mode: 0o644,
        base64: Buffer.from('retained reported experience').toString('base64'),
      },
    ],
  });
  await f.call('memory', 'memoryUpdater', 1, { output: { memoryRef } });
  const absent = await f.collect('r1', 2);
  assert.equal(
    JSON.stringify(absent.snapshot).includes('retained reported experience'),
    false,
  );
  const present = await f.collect('selected', 2, {
    names: ['memoryUpdater'],
    moduleKey: 'memory-module',
  });
  const files = object(present.snapshot.files);
  assert.equal(
    files['context/reflection/calls/memory-memoryRef.json/0.txt'],
    'retained reported experience',
  );
  assert.match(
    string(files['context/reflection/calls/memory-memoryRef.json/index.json']),
    /experience.md/,
  );
});

test('one latest direct-previous-version call per binding supplies readable version content and differences', async (t) => {
  const f = await fixture(t);
  const resource = async (text: string) =>
    f.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'bindings/proposer/resources/guidance/rules.md',
          mode: 0o644,
          base64: Buffer.from(text).toString('base64'),
        },
      ],
    });
  await f.facts.write('revisions', 'initial', {
    ref: 'initial',
    experimentId: 'experiment',
    binding: 'proposer',
    kind: 'initial',
    resourceRef: await resource('before'),
  });
  await f.facts.write('revisions', 'current', {
    ref: 'current',
    experimentId: 'experiment',
    binding: 'proposer',
    parentRef: 'initial',
    resourceRef: await resource('after'),
  });
  await f.call('oldest', 'proposer', 1, {
    revisionRef: null,
    input: { taskId: 'task' },
  });
  await f.call('latest', 'proposer', 2, {
    revisionRef: null,
    input: { taskId: 'other-task' },
  });
  await f.collect('r1', 3);
  await f.call('current-call', 'proposer', 4, {
    revisionRef: 'current',
    input: { taskId: 'task' },
  });
  const { snapshot } = await f.collect('r2', 5);
  const index = object(snapshot.index);
  const retrospective = (index.calls as JsonObject[]).filter(
    (entry) => entry.role === 'retrospective-comparison',
  );
  assert.deepEqual(
    retrospective.map((entry) => entry.callId),
    ['latest'],
  );
  assert.equal(
    (index.comparisons as JsonObject[])[0]!.taskComparison,
    'different',
  );
  assert.match(
    string(
      object(snapshot.files)[
        'context/reflection/versions/current-difference.patch'
      ],
    ),
    /-before\n\+after/,
  );
  assert.equal(
    object(snapshot.files)[
      'context/reflection/versions/initial/bindings/proposer/resources/guidance/rules.md'
    ],
    'before',
  );
});

test('execution filters scoring inputs while training-summary supplies only authorized normalized feedback and public bytes', async (t) => {
  const f = await fixture(t);
  const publicRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'public.xlsx',
        mode: 0o644,
        base64: Buffer.from([0, 1, 2, 3]).toString('base64'),
      },
      {
        path: 'readable.txt',
        mode: 0o644,
        base64: Buffer.from('public execution').toString('base64'),
      },
    ],
  });
  const privateRef = await f.artifacts.putJson({
    text: 'private verifier marker',
  });
  const source = { artifactRef: privateRef, pointer: '' };
  const feedbackRef = await f.artifacts.putJson({
    schemaVersion: 'rsi.evaluation-feedback/v1',
    itemId: 'task',
    attemptId: null,
    executionStatus: 'succeeded',
    scoreStatus: 'valid',
    passed: false,
    primaryReward: '0.25',
    passThreshold: 0.5,
    checks: [],
    checksComplete: true,
    diagnostics: [
      {
        kind: 'hint',
        code: null,
        message:
          'authorized returned hint ' + 'x'.repeat(1024 * 1024) + ' HINT_END',
        source,
        truncated: false,
      },
    ],
    truncated: false,
    source,
  });
  const evidenceIndexRef = await f.artifacts.putJson({
    entries: [
      {
        kind: 'delivery',
        access: 'delivery',
        artifactRef: publicRef,
        integrity: 'complete',
      },
      {
        kind: 'delivery',
        access: 'delivery',
        artifactRef: publicRef,
        integrity: 'complete',
        itemId: 'another-task',
      },
      {
        kind: 'verifier',
        access: 'private',
        artifactRef: privateRef,
        integrity: 'complete',
      },
    ],
  });
  const itemsRef = await f.artifacts.putJson({
    items: [
      { id: 'task', metrics: {}, evaluation: { artifactRef: feedbackRef } },
    ],
  });
  await f.facts.write('measurements', 'measurement', {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'measurement',
    experimentId: 'experiment',
    evidenceIndexRef,
    itemsRef,
    status: 'succeeded',
    metrics: {},
  });
  await f.call('observer', 'proposer', 1, {
    output: {
      measurementRef: 'measurement',
      evaluation: { diagnostics: ['scoring input marker'] },
      datasetHints: ['dataset hint marker'],
      metrics: { secretScore: 42 },
    },
  });
  const execution = await f.collect('execution', 2);
  assert.equal(
    JSON.stringify(execution.snapshot).includes('scoring input marker'),
    false,
  );
  assert.equal(
    JSON.stringify(execution.snapshot).includes('dataset hint marker'),
    false,
  );
  assert.equal(
    JSON.stringify(execution.snapshot).includes('authorized returned hint'),
    false,
  );
  const descriptors = execution.snapshot.sources as JsonObject[];
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]!.artifactRef, publicRef);
  assert.equal(descriptors[0]!.path, 'public.xlsx');
  assert.equal((descriptors[0]!.associations as JsonObject[]).length, 2);
  assert.equal(
    Object.values(object(execution.snapshot.files)).filter(
      (value) => value === 'public execution',
    ).length,
    1,
  );
  const training = await f.collect('training', 2, {
    moduleKey: 'training-module',
    view: 'training-summary',
    maxBytes: 4 * 1024 * 1024,
  });
  const delivered = JSON.stringify(training.snapshot.files);
  assert.equal(delivered.includes('authorized returned hint'), true);
  assert.equal(delivered.includes('HINT_END'), true);
  assert.equal(delivered.includes('private verifier marker'), false);
  assert.equal(delivered.includes('public execution'), true);
  assert.equal(delivered.includes('scoring input marker'), false);
});

test('recovery finds a durably prepared snapshot before its controller link was saved', async (t) => {
  const f = await fixture(t);
  await f.call('first', 'proposer', 1);
  const original = await f.collect('same-invocation', 3);
  await f.call('late-durable-receipt', 'proposer', 2);
  const recovered = await f.collect('same-invocation', 3);
  assert.deepEqual(recovered, original);
  assert.deepEqual(recovered.result.callIds, ['first']);
  const changed = {
    ...original.snapshot,
    callCount: 2,
    callIds: ['first', 'late-durable-receipt'],
  };
  await f.facts.write('evidence-views', 'evidence-inconsistent', changed);
  await assert.rejects(
    f.collect('same-invocation', 3),
    /inconsistent persisted evidence/,
  );
});

test('composition source identities survive projection without expanding unselected histories', async (t) => {
  const f = await fixture(t);
  await f.call('hidden-producer', 'otherProposer', 1, {
    output: {
      candidateRef: 'source-candidate',
      rationale: 'unselected producer history marker',
    },
  });
  await f.call('composition', 'composer', 2, {
    input: {
      parent: 'base',
      sources: [
        {
          candidateRef: 'source-candidate',
          measurementRef: 'unloaded-measurement',
        },
        { candidateRef: 'second-source' },
      ],
    },
    output: { candidateRef: 'composed' },
  });
  const { snapshot } = await f.collect('composition-reflection', 3, {
    names: ['composer'],
  });
  const calls = object(snapshot.index).calls as JsonObject[];
  assert.equal(calls.length, 1);
  assert.deepEqual(object(calls[0]!.relationships).sources, [
    { candidate: 'source-candidate', measurement: 'unloaded-measurement' },
    { candidate: 'second-source', measurement: null },
  ]);
  assert.deepEqual(snapshot.measurementRefs, []);
  assert.equal(
    JSON.stringify(snapshot).includes('unselected producer history marker'),
    false,
  );
});

test('a rejected trigger with failed evidence preparation still bounds the next window without admitting its calls', async (t) => {
  const f = await fixture(t);
  await f.call('old-primary', 'proposer', 1, {
    output: { candidateRef: 'candidate', measurementRef: 'broken-measurement' },
    input: { parent: 'base' },
  });
  const corruptIndex = await f.artifacts.putJson({
    entries: 'invalid evidence index',
  });
  await f.facts.write('measurements', 'broken-measurement', {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'broken-measurement',
    experimentId: 'experiment',
    evidenceIndexRef: corruptIndex,
  });
  await assert.rejects(
    f.collect('rejected-trigger', 2),
    /Invalid Measurement evidence index/,
  );
  assert.deepEqual(await f.facts.list('evidence-views'), []);
  await f.facts.write('reflection', 'rejected-trigger', {
    reflectionId: 'rejected-trigger',
    experimentId: 'experiment',
    policyScopeId: 'root',
    configFile: 'module',
    stepPath: 'first',
    startedAt: at(2),
    status: 'rejected',
  });
  await f.call('late-unadmitted-result', 'evaluator', 3, {
    input: { candidateRef: 'candidate' },
    output: {},
    status: 'failed',
  });
  await f.call('new-primary', 'proposer', 3);
  const later = await f.collect('next-trigger', 4);
  assert.deepEqual(later.result.callIds, ['new-primary']);
  assert.equal(later.snapshot.windowStart, at(2));
  assert.equal(later.result.callCount, 1);
  assert.deepEqual(object(later.snapshot.index).lateResults, []);
  assert.equal(JSON.stringify(later.snapshot).includes('old-primary'), false);
  assert.equal(
    JSON.stringify(later.snapshot).includes('late-unadmitted-result'),
    false,
  );
});

test('prepared snapshot recovery rejects a changed evidence view or module configuration digest', async (t) => {
  const f = await fixture(t);
  await f.call('primary', 'proposer', 1);
  const prepared = await f.collect('same-invocation', 2, {
    configDigest: 'first-config',
  });
  await assert.rejects(
    f.collect('same-invocation', 2, {
      priorRef: string(prepared.result.ref),
      configDigest: 'first-config',
      view: 'training-summary',
    }),
    /snapshot ownership mismatch/,
  );
  await assert.rejects(
    f.collect('same-invocation', 2, {
      priorRef: string(prepared.result.ref),
      configDigest: 'changed-config',
    }),
    /snapshot ownership mismatch/,
  );
  await assert.rejects(
    f.collect('same-invocation', 2, { configDigest: 'changed-config' }),
    /inconsistent persisted evidence/,
  );
});

test('authorized empty execution files remain readable by the Reflection Agent and deduplicate normally', async (t) => {
  const f = await fixture(t);
  const executionRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [
      { path: 'stderr.txt', mode: 0o644, base64: '' },
      {
        path: 'stdout.txt',
        mode: 0o644,
        base64: Buffer.from('available output').toString('base64'),
      },
    ],
  });
  const evidenceIndexRef = await f.artifacts.putJson({
    entries: [
      {
        kind: 'trajectory',
        access: 'execution',
        artifactRef: executionRef,
        integrity: 'complete',
      },
      {
        kind: 'trajectory',
        access: 'execution',
        artifactRef: executionRef,
        integrity: 'complete',
      },
    ],
  });
  await f.facts.write('measurements', 'measurement', {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'measurement',
    experimentId: 'experiment',
    evidenceIndexRef,
  });
  await f.call('observer', 'proposer', 1, {
    output: { measurementRef: 'measurement' },
  });
  const { result, snapshot } = await f.collect('empty-execution', 2);
  const emptyPaths = Object.entries(object(snapshot.files))
    .filter(([, content]) => content === '')
    .map(([path]) => path);
  assert.equal(emptyPaths.length, 1);
  const emptyPath = emptyPaths[0]!;
  const resourcePath = 'bindings/proposer/resources/guidance/initial.md';
  const resourceRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: resourcePath,
        mode: process.platform === 'win32' ? 0o666 : 0o644,
        base64: '',
      },
    ],
  });
  const prompt = join(f.root, 'reflection-prompt.md');
  await writeFile(prompt, 'Inspect authorized execution files.');
  let modelRequests = 0;
  const context = f.context.extend({
    signal: new AbortController().signal,
    workspaces: new FileWorkspaces(join(f.root, 'workspaces'), f.artifacts),
    invokeAgent: async (request: JsonObject): Promise<JsonObject> => {
      modelRequests++;
      const files = object(request.files);
      assert.equal(readVirtualFile(files, { path: emptyPath }), '');
      assert.equal(readVirtualFile(files, { path: resourcePath }), '');
      assert.equal(
        Object.values(files).filter((content) => content === 'available output')
          .length,
        1,
      );
      return {
        edits: [],
        reason: 'Empty captured stderr is readable evidence',
      };
    },
  });
  const operation = await createReflectionAgent(
    { prompt, evidenceView: 'execution' },
    context,
  );
  try {
    const output = await operation.execute(
      {
        parentRevisionRefs: { proposer: 'initial' },
        resourceRef,
        goal: 'Inspect execution',
        evidenceRefs: [string(result.ref)],
        editConstraints: {},
      },
      context,
    );
    assert.equal(output.status, 'no-change');
    assert.equal(modelRequests, 1);
  } finally {
    await operation.dispose();
  }
});

test('ASCII PDF delivery reaches the Reflection Agent as page previews through evidence collection', async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(
    new URL('../fixtures/reflection/pages.pdf', import.meta.url),
  );
  assert.match(
    new TextDecoder('utf8', { fatal: true }).decode(bytes),
    /^%PDF-/,
  );
  const artifactRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [
      { path: 'pages.PDF', mode: 0o644, base64: bytes.toString('base64') },
    ],
  });
  const evidenceIndexRef = await f.artifacts.putJson({
    entries: ['first-task', 'second-task'].map((itemId) => ({
      kind: 'delivery',
      access: 'delivery',
      artifactRef,
      integrity: 'complete',
      itemId,
    })),
  });
  await f.facts.write('measurements', 'measurement', {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'measurement',
    experimentId: 'experiment',
    evidenceIndexRef,
  });
  await f.call('observer', 'proposer', 1, {
    output: { measurementRef: 'measurement' },
  });
  const { result, snapshot } = await f.collect('pdf-evidence', 2);
  const sources = snapshot.sources as JsonObject[];
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.path, 'pages.PDF');
  assert.equal((sources[0]!.associations as JsonObject[]).length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot.files), /%PDF-/);
  const resourceRef = await f.artifacts.putJson({
    kind: 'file-tree',
    files: [],
  });
  const prompt = join(f.root, 'prompt.md');
  await writeFile(prompt, 'Inspect the delivery.');
  let requests = 0;
  const context = f.context.extend({
    signal: new AbortController().signal,
    workspaces: new FileWorkspaces(join(f.root, 'workspaces'), f.artifacts),
    invokeAgent: async (request: JsonObject): Promise<JsonObject> => {
      requests++;
      const files = object(request.files);
      const index = object(
        JSON.parse(string(files['context/reflection/index.json'])),
      );
      const previews = index.previews as JsonObject[];
      assert.equal(previews.length, 1);
      assert.equal(previews[0]!.inspection, 'complete');
      assert.equal(object(previews[0]!.source).artifactRef, artifactRef);
      assert.deepEqual(previews[0]!.locations, [
        { page: 1, extractableText: true },
        { page: 2, extractableText: true },
        { page: 3, extractableText: false },
      ]);
      const preview = readVirtualFile(files, {
        path: string(previews[0]!.path),
      });
      assert.match(preview, /Page 1\nFirst page/);
      assert.match(preview, /Page 2\nSecond page/);
      assert.match(preview, /Page 3\n\[No extractable text/);
      assert.doesNotMatch(JSON.stringify(files), /%PDF-/);
      return { edits: [], reason: 'Read all three pages' };
    },
  });
  const operation = await createReflectionAgent(
    { prompt, evidenceView: 'execution' },
    context,
  );
  try {
    assert.equal(
      (
        await operation.execute(
          {
            parentRevisionRefs: { proposer: 'initial' },
            resourceRef,
            goal: 'Inspect delivery',
            evidenceRefs: [string(result.ref)],
            editConstraints: {},
          },
          context,
        )
      ).status,
      'no-change',
    );
    assert.equal(requests, 1);
  } finally {
    await operation.dispose();
  }
});

test('an observed binding with no new current-version call exposes only its direct resource difference', async (t) => {
  const f = await fixture(t);
  const resource = async (content: string) =>
    f.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'bindings/proposer/resources/guidance/rules.md',
          mode: 0o644,
          base64: Buffer.from(content).toString('base64'),
        },
      ],
    });
  await f.facts.write('revisions', 'initial', {
    ref: 'initial',
    experimentId: 'experiment',
    binding: 'proposer',
    kind: 'initial',
    resourceRef: await resource('original rule'),
  });
  await f.call('before-call', 'proposer', 1, { revisionRef: null });
  await f.collect('r1', 2);
  await f.facts.write('revisions', 'generated-final', {
    ref: 'generated-final',
    experimentId: 'experiment',
    binding: 'proposer',
    parentRef: 'initial',
    resourceRef: await resource('revised rule'),
  });
  const emptyWindow = await f.collect('r2', 3, {
    currentRevisionRefs: {
      proposer: 'generated-final',
      unselected: 'must-not-load',
    },
  });
  assert.equal(emptyWindow.result.callCount, 0);
  assert.deepEqual(emptyWindow.result.callIds, []);
  assert.deepEqual(object(emptyWindow.snapshot.index).calls, []);
  const comparisons = object(emptyWindow.snapshot.index)
    .comparisons as JsonObject[];
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0]!.binding, 'proposer');
  assert.equal(comparisons[0]!.callId, null);
  assert.equal(comparisons[0]!.previousCallId, null);
  assert.equal(comparisons[0]!.afterExecution, 'not-in-window');
  assert.equal(comparisons[0]!.resourceOnly, true);
  assert.match(
    string(comparisons[0]!.limitation),
    /No current-version execution call/,
  );
  const files = object(emptyWindow.snapshot.files);
  assert.match(
    string(
      files['context/reflection/versions/generated-final-difference.patch'],
    ),
    /-original rule\n\+revised rule/,
  );
  assert.equal(
    files[
      'context/reflection/versions/initial/bindings/proposer/resources/guidance/rules.md'
    ],
    'original rule',
  );
  assert.equal(
    files[
      'context/reflection/versions/generated-final/bindings/proposer/resources/guidance/rules.md'
    ],
    'revised rule',
  );
  assert.equal(JSON.stringify(files).includes('before-call'), false);
  await f.call('new-memory-call', 'memoryUpdater', 4);
  const next = await f.collect('r3', 5, {
    names: ['proposer', 'memoryUpdater'],
    currentRevisionRefs: { proposer: 'generated-final' },
  });
  assert.equal(next.result.callCount, 1);
  assert.deepEqual(next.result.callIds, ['new-memory-call']);
  assert.deepEqual(
    (object(next.snapshot.index).calls as JsonObject[]).map(
      (entry) => entry.callId,
    ),
    ['new-memory-call'],
  );
  assert.equal(
    (object(next.snapshot.index).comparisons as JsonObject[])[0]!
      .afterExecution,
    'not-in-window',
  );
});
