import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
import { collectEvolutionEvidence } from '../../src/runtime/evolution/evidence.js';
import { projectCandidateEvidence } from '../../src/runtime/evolution/candidate-evidence.js';
import { object, string } from '../../src/shared/json.js';

test('WikiSkill windows project training, candidate diffs and selection aggregates without held-out traces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-wiki-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const facts = new FileFacts(join(root, 'facts'));
  const tree = async (content: string) =>
    artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'skill.md',
          mode: 420,
          base64: Buffer.from(content).toString('base64'),
        },
      ],
    });
  const baseline = await tree('old procedure');
  const candidate = await tree('new procedure');
  const context = new RuntimeContext().extend({
    experimentId: 'wiki',
    facts,
    artifacts,
    signal: new AbortController().signal,
    applicationMetadata: async () => ({ initialCandidateRef: 'base' }),
    readCandidate: async (ref) => ({
      ref,
      parentRef: ref === 'base' ? null : 'base',
      artifactRef: ref === 'base' ? baseline : candidate,
      experimentId: 'wiki',
    }),
    readMeasurement: async (ref) => facts.read('measurements', ref),
  });
  const time = (n: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const call = async (
    id: string,
    path: string,
    input: JsonObject,
    output: JsonObject,
    n: number,
  ) =>
    facts.write('calls', id, {
      experimentId: 'wiki',
      callId: id,
      parentCallId: 'root',
      bindingId: id.split('-')[0],
      ...(id.startsWith('selector-')
        ? { contractId: 'contract.selector-metrics' }
        : {}),
      input,
      output,
      path,
      finishedAt: time(n),
      status: 'succeeded',
    });
  const evaluation = async (
    id: string,
    path: string,
    candidateRef: string,
    marker: string,
    n: number,
  ) => {
    const evidenceIndexRef = await artifacts.putJson({
      entries: [
        {
          kind: 'final-text',
          access: 'execution',
          integrity: 'complete',
          artifactRef: await artifacts.putJson(marker),
          itemId: id,
        },
      ],
    });
    const ref = 'm-' + id;
    await facts.write('measurements', ref, {
      schemaVersion: 'rsi.measurement/v1',
      experimentId: 'wiki',
      ref,
      candidateRef,
      evidenceIndexRef,
      metrics: {},
    });
    await call(id, path, { candidateRef }, { measurementRef: ref }, n);
  };
  const collect = async (identity: string, n: number) => {
    const { ref } = await collectEvolutionEvidence({
      kind: 'memory',
      context,
      identity,
      capturedAt: time(n),
      configDigest: 'wiki',
      view: 'training-summary',
      observe: {
        steps: [
          'steps/search/steps/train',
          'steps/search/steps/propose',
          'steps/search/steps/select',
        ],
        excludeSteps: [
          'steps/baseline',
          'steps/search/steps/validate',
          'steps/test_if_requested/then/steps/test',
        ],
        includeBaseline: true,
        includeCandidateDiffs: true,
      },
    });
    return facts.read('evidence-views', string(ref));
  };
  const round = (n: number) => `steps/search/iteration-${n}/`;
  await evaluation(
    'eval-base',
    'steps/baseline',
    'base',
    'HIDDEN_BASELINE_TRACE',
    1,
  );
  await evaluation(
    'eval-train0',
    round(0) + 'train',
    'base',
    'TRAINING_ROUND_ZERO',
    2,
  );
  const first = await collect('round0', 3);
  assert.deepEqual(first.callIds, ['eval-train0']);
  assert.match(JSON.stringify(first.files), /TRAINING_ROUND_ZERO/);
  await call(
    'proposer-edit',
    round(0) + 'propose',
    { parent: 'base', evidenceRefs: ['m-eval-train0', 'm-eval-base'] },
    {
      status: 'created',
      candidateRef: 'new',
      rationale: 'Observed training difficulty',
    },
    4,
  );
  await evaluation(
    'eval-valid',
    round(0) + 'validate',
    'new',
    'HIDDEN_VALIDATION_TRACE',
    5,
  );
  await call(
    'selector-gate',
    round(0) + 'select',
    {
      incumbentMeasurementRef: 'm-eval-base',
      candidateMeasurementRef: 'm-eval-valid',
    },
    {
      accepted: true,
      selectedCandidateRef: 'new',
      measurementRef: 'm-eval-valid',
      selectedValue: 0.8,
    },
    6,
  );
  await evaluation(
    'eval-train1',
    round(1) + 'train',
    'new',
    'TRAINING_ROUND_ONE',
    7,
  );
  await evaluation(
    'eval-test',
    'steps/test_if_requested/then/test',
    'new',
    'HIDDEN_TEST_TRACE',
    8,
  );
  const second = await collect('round1', 9);
  const files = object(second.files);
  assert.deepEqual(second.callIds, [
    'proposer-edit',
    'selector-gate',
    'eval-train1',
  ]);
  assert.deepEqual([...(second.measurementRefs as string[])].sort(), [
    'm-eval-train0',
    'm-eval-train1',
  ]);
  assert.doesNotMatch(
    JSON.stringify(second),
    /HIDDEN_(BASELINE|VALIDATION|TEST)_TRACE/,
  );
  assert.match(
    string(files['context/evolution/calls/selector-gate.json']),
    /"accepted":true/,
  );
  assert.doesNotMatch(
    string(files['context/evolution/calls/selector-gate.json']),
    /selectedValue/,
  );
  assert.match(
    string(files['context/evolution/training-summary.json']),
    /TRAINING_ROUND_ONE/,
  );
  assert.ok(
    !Object.keys(files).some((path) =>
      path.startsWith('context/evolution/candidates/'),
    ),
  );
  const comparisons = string(files['context/evolution/comparisons.json']);
  assert.match(comparisons, /-old procedure/);
  assert.match(comparisons, /\+new procedure/);
  assert.match(comparisons, /iteration-1\/train/);

  const selected = { candidateRef: 'new', measurementRef: 'm-eval-train1' };
  const decisionRef = await artifacts.putJson({
    kind: 'artifact-decision',
    selectedIndex: 0,
    candidates: [{ ...selected, originalIndex: 0 }],
    reason: 'Most complete delivery',
  });
  const selection = {
    record: { callId: 'decision', pluginId: 'selector.artifact' },
    input: { candidates: [selected] },
    output: { ...selected, decisionRef },
    frame: '',
    parent: '',
  };
  const project = () =>
    projectCandidateEvidence(context, [selection], false, (path, text) => {
      files[path] = text;
    });
  await project();
  assert.match(
    string(files['context/evolution/comparisons.json']),
    /Most complete delivery/,
  );
  const withheld = { candidateRef: 'base', measurementRef: 'm-eval-base' };
  const hiddenRef = await artifacts.putJson({
    kind: 'artifact-decision',
    selectedIndex: 0,
    reason: 'QUOTED_HELD_OUT_DELIVERY',
    candidates: [
      { ...selected, originalIndex: 0 },
      { ...withheld, originalIndex: 1 },
    ],
  });
  await facts.write('calls', 'artifact-choice', {
    experimentId: 'wiki',
    callId: 'artifact-choice',
    parentCallId: 'root',
    status: 'succeeded',
    bindingId: 'selector',
    pluginId: 'selector.artifact',
    contractId: 'contract.selector-artifacts',
    path: 'steps/judge',
    finishedAt: time(11),
    input: { candidates: [selected, withheld] },
    output: {
      ...selected,
      decisionRef: hiddenRef,
      reason: 'QUOTED_HELD_OUT_DELIVERY',
    },
  });
  await facts.write('calls', 'artifact-agent', {
    experimentId: 'wiki',
    callId: 'artifact-agent',
    parentCallId: 'artifact-choice',
    status: 'succeeded',
    bindingId: 'agent',
    path: 'steps/judge/agent',
    finishedAt: time(10),
    input: {},
    output: { reason: 'QUOTED_HELD_OUT_DELIVERY' },
  });
  const scoped = await collectEvolutionEvidence({
    kind: 'reflection',
    context,
    identity: 'choice-window',
    capturedAt: time(12),
    configDigest: 'choice',
    observe: {
      bindings: ['selector', 'agent'],
      excludeSteps: ['steps/baseline'],
      includeCandidateDiffs: true,
    },
  });
  const decisionSnapshot = await facts.read(
    'evidence-views',
    string(scoped.ref),
  );
  assert.doesNotMatch(
    JSON.stringify(decisionSnapshot),
    /QUOTED_HELD_OUT_DELIVERY|HIDDEN_BASELINE_TRACE|artifact-agent/,
  );
  const decisionSummary = JSON.parse(
    string(
      object(decisionSnapshot.files)['context/evolution/comparisons.json'],
    ),
  );
  assert.equal(decisionSummary.selections[0].selectedCandidateRef, 'new');
  assert.equal(decisionSummary.selections[0].selectionReason, null);
  selection.output.measurementRef = 'another-measurement';
  await assert.rejects(project(), /selection does not match/);
  await assert.rejects(
    projectCandidateEvidence(
      context.extend({
        readCandidate: async (ref) => ({
          ref,
          parentRef: null,
          artifactRef: baseline,
          experimentId: 'foreign',
        }),
      }),
      [{ ...selection, record: {}, output: { candidateRef: 'new' } }],
      false,
      () => {},
    ),
    /another experiment/,
  );
});
