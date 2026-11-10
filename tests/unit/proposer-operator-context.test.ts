import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeContext } from '../../src/contracts/index.js';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
import { object, string, digest } from '../../src/shared/json.js';
import {
  parseStaticDiagnosis,
  readAnalysis,
  readHistory,
} from '../../src/plugins/proposer-operator/service.js';
import {
  configSchema,
  type OperatorProposerConfig,
} from '../../src/plugins/proposer-operator/schema.js';
import { validate, parseConfig } from '../../src/shared/schema.js';

const source =
  'def kernel_function(x):\n    for i in range(4):\n        y = x + 1\n    return y\n';
const issue = {
  issue_type: 'loop_invariant_hoisting',
  issue_summary: 'Repeated invariant expression',
  problematic_code: ['        y = x + 1'],
  evidence: ['x does not change in the visible loop'],
};

test('static diagnosis accepts only supported source-backed issues and preserves an empty valid diagnosis', () => {
  assert.deepEqual(parseStaticDiagnosis([], source), []);
  assert.deepEqual(parseStaticDiagnosis([issue], source), [issue]);
  for (const value of [
    null,
    {},
    '[ ]',
    [{ ...issue, issue_type: 'invented' }],
    [{ ...issue, problematic_code: ['not in source'] }],
    [{ ...issue, problematic_code: [''] }],
    [{ ...issue, evidence: [] }],
    [{ ...issue, extra: true }],
  ]) {
    assert.throws(() => parseStaticDiagnosis(value, source));
  }
});

test('operator config requires explicit retrieval resources and permits only CPU retrieval', () => {
  const config = parseConfig<OperatorProposerConfig>(configSchema, {
    promptsDirectory: '/prompts',
    task: { directory: '/task' },
    embedding: {
      python: '/venv/bin/python',
      resourcesDirectory: '/resources',
      retrievalScript: '/resources/retrieve.py',
      modelDirectory: '/models/embedding',
      identityFile: '/models/identity.json',
    },
  });
  validate(configSchema, config);
  assert.equal(config.embedding.device, 'cpu');
  assert.equal(config.embedding.timeoutMs, 300000);
  assert.equal(config.embedding.similarityThreshold, 0.6);
  assert.throws(() =>
    validate(configSchema, {
      ...config,
      embedding: { ...config.embedding, device: 'npu' },
    }),
  );
  const missing = structuredClone(config);
  Reflect.deleteProperty(missing.embedding, 'identityFile');
  assert.throws(() => validate(configSchema, missing));
  const missingPrompts = structuredClone(config);
  Reflect.deleteProperty(missingPrompts, 'promptsDirectory');
  assert.throws(() => validate(configSchema, missingPrompts));
});

test('operator config accepts disabled or extended deadlines and explicit retrieval byte limits', () => {
  const raw = {
    promptsDirectory: '/prompts',
    task: { directory: '/task' },
    historyWindow: 11,
    modelRequestTimeoutMs: 0,
    embedding: {
      python: '/venv/bin/python',
      resourcesDirectory: '/resources',
      retrievalScript: '/resources/retrieve.py',
      modelDirectory: '/models/embedding',
      identityFile: '/models/identity.json',
      timeoutMs: 0,
      maxPayloadBytes: 4194304,
      maxLogBytes: 131072,
    },
  };
  validate(configSchema, raw);
  validate(configSchema, {
    ...raw,
    modelRequestTimeoutMs: 2147483647,
    embedding: { ...raw.embedding, timeoutMs: 2147483647 },
  });
  for (const timeout of [-1, 0.5, 2147483648])
    assert.throws(() =>
      validate(configSchema, { ...raw, modelRequestTimeoutMs: timeout }),
    );
  for (const bytes of [0, 0.5, 9007199254740992])
    assert.throws(() =>
      validate(configSchema, {
        ...raw,
        embedding: { ...raw.embedding, maxPayloadBytes: bytes },
      }),
    );
});

async function fixture() {
  const sourcePath = 'kernels/transpose[0].py';
  const directory = await mkdtemp(join(tmpdir(), 'operator-context-'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const facts = new FileFacts(join(directory, 'facts'));
  const conditions = {
    mode: 'sdk',
    taskDigest: '1'.repeat(64),
    adapterDigest: '2'.repeat(64),
    sdkBuildDigest: '3'.repeat(64),
    evaluation: {
      contract: { caseId: 'fixed' },
      environment: { device: 'TEST-FIXTURE' },
      protocol: { warmup: 5, repeat: 20 },
    },
  };
  const conditionsRef = await artifacts.putJson(conditions);
  const comparisonKey = digest(conditions);
  const tree = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: sourcePath,
        mode: 420,
        base64: Buffer.from(source).toString('base64'),
      },
    ],
  });
  await facts.write('candidates', 'entry', {
    ref: 'entry',
    experimentId: 'experiment',
    parentRef: null,
    artifactRef: tree,
  });
  const changedSource = source + '# changed\n';
  const candidateTree = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: sourcePath,
        mode: 420,
        base64: Buffer.from(changedSource).toString('base64'),
      },
    ],
  });
  await facts.write('candidates', 'candidate', {
    ref: 'candidate',
    experimentId: 'experiment',
    parentRef: 'entry',
    artifactRef: candidateTree,
  });
  const provenance = await artifacts.putJson({
    mode: 'sdk',
    sourceDigest: createHash('sha256').update(source).digest('hex'),
    artifactRef: tree,
    runId: 'run',
    attemptId: 'attempt',
    realNpuRuns: null,
    cleanup: 'confirmed',
  });
  const candidateProvenance = await artifacts.putJson({
    mode: 'sdk',
    sourceDigest: createHash('sha256').update(changedSource).digest('hex'),
    artifactRef: candidateTree,
    runId: 'candidate-run',
    attemptId: 'candidate-attempt',
    realNpuRuns: null,
    cleanup: 'confirmed',
  });
  const measurement = (ref: string, candidateRef: string, value: number) => ({
    schemaVersion: 'rsi.measurement/v1',
    ref,
    experimentId: 'experiment',
    callId: ref,
    candidateRef,
    evaluator: {
      pluginId: 'evaluator.operatorbench',
      implementationDigest: '2'.repeat(64),
    },
    startedAt: '2026-11-03T00:00:00Z',
    finishedAt: '2026-11-03T00:00:01Z',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey,
    conditions: {
      schemaId: 'rsi.operator-sdk-conditions/v1',
      schemaDigest: '4'.repeat(64),
      artifactRef: conditionsRef,
    },
    provenance: {
      schemaId: 'rsi.operator-sdk-provenance/v1',
      schemaDigest: '5'.repeat(64),
      artifactRef: candidateRef === 'entry' ? provenance : candidateProvenance,
    },
    metrics: {
      candidateValid: {
        status: 'available',
        value: { kind: 'scalar', value: 1 },
        definitionRef: 'valid-definition',
        source: { artifactRef: 'native', pointer: '' },
      },
      latencyMeanMs: {
        status: 'available',
        value: { kind: 'scalar', value },
        definitionRef: 'latency-definition',
        source: { artifactRef: 'native', pointer: '' },
      },
    },
    itemsRef: 'items',
    evidenceIndexRef: 'evidence',
    profile: {
      schemaId: 'profile',
      schemaDigest: '6'.repeat(64),
      artifactRef: 'profile',
    },
    diagnosticsRef: null,
    extensions: [],
  });
  await facts.write(
    'measurements',
    'baseline',
    measurement('baseline', 'entry', 10),
  );
  await facts.write(
    'measurements',
    'candidate-measurement',
    measurement('candidate-measurement', 'candidate', 12),
  );
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    signal: new AbortController().signal,
    artifacts,
    facts,
    async applicationMetadata() {
      return {
        target: {
          schemaVersion: 'rsi.target/v1',
          id: 'test',
          entries: [
            {
              path: sourcePath,
              kind: 'file',
              changes: ['modify'],
              description: 'Kernel',
            },
          ],
        },
      };
    },
    async readCandidate(ref: string) {
      const fact = await facts.read('candidates', ref);
      return {
        ref,
        experimentId: string(fact.experimentId),
        artifactRef: string(fact.artifactRef),
        parentRef: fact.parentRef === null ? null : string(fact.parentRef),
      };
    },
    async readMeasurement(ref: string) {
      return facts.read('measurements', ref);
    },
  });
  const identity = {
    entryCandidateRef: 'entry',
    baselineMeasurementRef: 'baseline',
    sourceDigest: createHash('sha256').update(source).digest('hex'),
    comparisonKey,
    taskDigest: conditions.taskDigest,
    contractDigest: digest(conditions.evaluation.contract),
    environmentDigest: digest(conditions.evaluation.environment),
    protocolDigest: digest(conditions.evaluation.protocol),
    resourcesDigest: '7'.repeat(64),
    embeddingDigest: '8'.repeat(64),
    retrievalDigest: '9'.repeat(64),
  };
  const analysis = {
    schemaVersion: 'rsi.operator-analysis/v1',
    experimentId: 'experiment',
    identity,
    baselineMs: 10,
    issues: [issue],
    matches: [],
    knowledgeContext: '',
  };
  const analysisRef = await artifacts.putJson(analysis);
  const decisionRef = await artifacts.putJson({
    kind: 'metric-decision',
    measurementRefs: ['baseline', 'candidate-measurement'],
    itemId: null,
    metric: 'latencyMeanMs',
    statistic: null,
    direction: 'minimize',
    tieBreak: 'retain-incumbent',
    minRelativeImprovement: 0.05,
    definitionRef: 'latency-definition',
    incumbentValue: 10,
    candidateValue: 12,
    eligibility: [],
    constraints: [],
    accepted: false,
    reason: 'slower',
  });
  const summary = {
    schemaVersion: 'rsi.operator-summary/v1',
    experimentId: 'experiment',
    analysisRef,
    attempt: 1,
    candidateRefs: ['candidate'],
    measurementRefs: ['candidate-measurement'],
    decisionRef,
    techniqueIds: [],
    actionSummary: 'One attempted change',
    facts: {
      outcome: 'verified-no-gain',
      wasTransformCorrect: true,
      baselineMs: 10,
      candidateMs: 12,
      accepted: false,
    },
    explanation: 'Measured slowdown; cause remains a hypothesis',
    lessons: ['Keep the original entry source'],
    avoidPatterns: ['This change'],
    tryPatterns: [],
  };
  return {
    directory,
    artifacts,
    facts,
    context,
    identity,
    analysis,
    analysisRef,
    summary,
  };
}

test('analysis binds the explicit baseline measurement to its owned entry and effective conditions', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  assert.deepEqual(
    await readAnalysis(f.analysisRef, f.identity, f.context),
    f.analysis,
  );
  for (const key of [
    'sourceDigest',
    'comparisonKey',
    'taskDigest',
    'contractDigest',
    'environmentDigest',
    'protocolDigest',
    'resourcesDigest',
    'embeddingDigest',
    'retrievalDigest',
  ] as const) {
    await assert.rejects(
      readAnalysis(
        f.analysisRef,
        { ...f.identity, [key]: 'a'.repeat(64) },
        f.context,
      ),
      /identity|mismatch/i,
    );
  }
  const changed = structuredClone(f.analysis);
  changed.identity.baselineMeasurementRef = 'candidate-measurement';
  await assert.rejects(
    readAnalysis(
      await f.artifacts.putJson(changed),
      changed.identity,
      f.context,
    ),
    /baseline|candidate/i,
  );
  const other = object(await f.facts.read('candidates', 'entry'));
  other.experimentId = 'other';
  await f.facts.write('candidates', 'entry', other);
  await assert.rejects(
    readAnalysis(f.analysisRef, f.identity, f.context),
    /experiment|ownership/i,
  );
});

test('multi-file analysis rejects an assessment that certifies only unchanged entry bytes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const candidate = await f.context.readCandidate('entry');
  const tree = object(await f.artifacts.readJson(candidate.artifactRef));
  assert.ok(Array.isArray(tree.files));
  const artifactRef = await f.artifacts.putJson({
    ...tree,
    files: [
      ...tree.files,
      {
        path: 'helper.py',
        mode: 420,
        base64: Buffer.from('BLOCK = 64\n').toString('base64'),
      },
    ],
  });
  await f.facts.write('candidates', 'entry', { ...candidate, artifactRef });
  const measurement = await f.facts.read('measurements', 'baseline');
  const provenance = object(
    await f.artifacts.readJson(
      string(object(measurement.provenance).artifactRef),
    ),
  );
  const provenanceRef = await f.artifacts.putJson({
    ...provenance,
    artifactRef,
  });
  await f.facts.write('measurements', 'baseline', {
    ...measurement,
    provenance: {
      ...object(measurement.provenance),
      artifactRef: provenanceRef,
    },
  });
  await assert.rejects(
    readAnalysis(f.analysisRef, f.identity, f.context),
    /source or cleanup mismatch/,
  );
});

test('analysis rereads complete knowledge context beyond the former text limit', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const knowledgeContext = 'External knowledge\n'.repeat(1500);
  const analysisRef = await f.artifacts.putJson({
    ...f.analysis,
    knowledgeContext,
    matches: [
      {
        techniqueId: 'loop_invariant_hoisting',
        score: 0.8,
        issueIndexes: [0],
        sourceReference: 'knowledge/hoisting.md',
        documentDigest: 'a'.repeat(64),
        exampleDigest: 'b'.repeat(64),
      },
    ],
  });
  assert.equal(
    (await readAnalysis(analysisRef, f.identity, f.context)).knowledgeContext,
    knowledgeContext,
  );
});

test('analysis validates persisted diagnosis, source bytes and baseline facts rather than trusting artifact labels', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const invalid = structuredClone(f.analysis);
  invalid.issues[0]!.problematic_code = ['invented source'];
  await assert.rejects(
    readAnalysis(await f.artifacts.putJson(invalid), f.identity, f.context),
    /source|snippet|code/i,
  );
  await assert.rejects(
    readAnalysis(
      await f.artifacts.putJson({ ...f.analysis, baselineMs: 1 }),
      f.identity,
      f.context,
    ),
    /baseline|latency/i,
  );
  const m = await f.facts.read('measurements', 'baseline');
  m.experimentId = 'other';
  await f.facts.write('measurements', 'baseline', m);
  await assert.rejects(
    readAnalysis(f.analysisRef, f.identity, f.context),
    /experiment|ownership/i,
  );
});

test('history resolves immutable summaries and checks candidate, measurement, decision and attempt ownership', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const summaryRef = await f.artifacts.putJson(f.summary);
  const history = {
    schemaVersion: 'rsi.operator-history/v1',
    experimentId: 'experiment',
    analysisRef: f.analysisRef,
    summaryRefs: [summaryRef],
  };
  assert.deepEqual(
    await readHistory(await f.artifacts.putJson(history), f.context),
    { ...history, summaries: [f.summary] },
  );
  assert.deepEqual(
    await readHistory(
      await f.artifacts.putJson({ ...history, summaryRefs: [] }),
      f.context,
    ),
    { ...history, summaryRefs: [], summaries: [] },
  );
  for (const change of [
    { experimentId: 'other' },
    { attempt: 2 },
    { analysisRef: 'missing-analysis' },
    { candidateRefs: ['entry'] },
    { facts: { ...f.summary.facts, wasTransformCorrect: false } },
    { facts: { ...f.summary.facts, accepted: true } },
    { facts: { ...f.summary.facts, candidateMs: 1 } },
  ]) {
    const wrongRef = await f.artifacts.putJson({ ...f.summary, ...change });
    await assert.rejects(
      readHistory(
        await f.artifacts.putJson({ ...history, summaryRefs: [wrongRef] }),
        f.context,
      ),
    );
  }
  await assert.rejects(
    readHistory(
      await f.artifacts.putJson({
        ...history,
        summaryRefs: [summaryRef, summaryRef],
      }),
      f.context,
    ),
  );
  const m = await f.facts.read('measurements', 'candidate-measurement');
  m.experimentId = 'other';
  await f.facts.write('measurements', 'candidate-measurement', m);
  await assert.rejects(
    readHistory(await f.artifacts.putJson(history), f.context),
    /experiment|ownership/i,
  );
});

test('history supports accepted, failed and no-change facts without letting the model supply missing measurements', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const check = async (summary: unknown) =>
    readHistory(
      await f.artifacts.putJson({
        schemaVersion: 'rsi.operator-history/v1',
        experimentId: 'experiment',
        analysisRef: f.analysisRef,
        summaryRefs: [await f.artifacts.putJson(summary)],
      }),
      f.context,
    );
  const unchanged = {
    ...f.summary,
    candidateRefs: ['entry'],
    measurementRefs: [],
    decisionRef: null,
    facts: {
      outcome: 'no-change',
      wasTransformCorrect: null,
      baselineMs: 10,
      candidateMs: null,
      accepted: false,
    },
  };
  assert.equal(
    (await check(unchanged)).summaries[0]!.facts.wasTransformCorrect,
    null,
  );
  const m = await f.facts.read('measurements', 'candidate-measurement');
  object(object(m.metrics).latencyMeanMs).value = { kind: 'scalar', value: 8 };
  await f.facts.write('measurements', 'candidate-measurement', m);
  const oldDecision = object(await f.artifacts.readJson(f.summary.decisionRef));
  const adopted = {
    ...f.summary,
    decisionRef: await f.artifacts.putJson({
      ...oldDecision,
      candidateValue: 8,
      accepted: true,
    }),
    facts: {
      ...f.summary.facts,
      outcome: 'adopted',
      candidateMs: 8,
      accepted: true,
    },
  };
  assert.equal((await check(adopted)).summaries[0]!.facts.accepted, true);
  m.coverage = 'partial';
  m.comparisonKey = null;
  object(object(m.metrics).candidateValid).value = { kind: 'scalar', value: 0 };
  object(m.metrics).latencyMeanMs = {
    status: 'unavailable',
    value: null,
    reason: 'Candidate check failed',
    definitionRef: 'latency-definition',
    source: null,
  };
  await f.facts.write('measurements', 'candidate-measurement', m);
  const failed = {
    ...f.summary,
    decisionRef: null,
    facts: {
      outcome: 'verification-failed',
      wasTransformCorrect: false,
      baselineMs: 10,
      candidateMs: null,
      accepted: false,
    },
  };
  assert.equal(
    (await check(failed)).summaries[0]!.facts.wasTransformCorrect,
    false,
  );
});

test('analysis checks actual conditions even if the caller repeats a forged stored identity', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  for (const key of [
    'sourceDigest',
    'comparisonKey',
    'taskDigest',
    'contractDigest',
    'environmentDigest',
    'protocolDigest',
  ] as const) {
    const identity = { ...f.identity, [key]: 'f'.repeat(64) };
    await assert.rejects(
      readAnalysis(
        await f.artifacts.putJson({ ...f.analysis, identity }),
        identity,
        f.context,
      ),
      /source|condition|identity|mismatch/i,
    );
  }
  const match = {
    techniqueId: 'loop_invariant_hoisting',
    score: 0.8,
    issueIndexes: [0],
    sourceReference: 'fixture-source',
    documentDigest: 'a'.repeat(64),
    exampleDigest: 'b'.repeat(64),
  };
  assert.equal(
    (
      await readAnalysis(
        await f.artifacts.putJson({
          ...f.analysis,
          matches: [match],
          knowledgeContext: 'Matched content',
        }),
        f.identity,
        f.context,
      )
    ).matches.length,
    1,
  );
  await assert.rejects(
    readAnalysis(
      await f.artifacts.putJson({
        ...f.analysis,
        matches: [{ ...match, techniqueId: 'pass_merge' }],
      }),
      f.identity,
      f.context,
    ),
    /match|diagnos/i,
  );
});

test('history rejects a measured baseline disguised as a new optimization candidate', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const raw = object(await f.artifacts.readJson(f.summary.decisionRef));
  const decisionRef = await f.artifacts.putJson({
    ...raw,
    measurementRefs: ['baseline', 'baseline'],
    candidateValue: 10,
    accepted: false,
  });
  const summary = {
    ...f.summary,
    candidateRefs: ['entry'],
    measurementRefs: ['baseline'],
    decisionRef,
    facts: { ...f.summary.facts, candidateMs: 10 },
  };
  const historyRef = await f.artifacts.putJson({
    schemaVersion: 'rsi.operator-history/v1',
    experimentId: 'experiment',
    analysisRef: f.analysisRef,
    summaryRefs: [await f.artifacts.putJson(summary)],
  });
  await assert.rejects(
    readHistory(historyRef, f.context),
    /candidate|entry|chain/i,
  );
});

test('history uses the Selector cutoff arithmetic at a strict floating point boundary', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const value = 9.299999999999999;
  const m = await f.facts.read('measurements', 'candidate-measurement');
  object(object(m.metrics).latencyMeanMs).value = { kind: 'scalar', value };
  await f.facts.write('measurements', 'candidate-measurement', m);
  const raw = object(await f.artifacts.readJson(f.summary.decisionRef));
  const decisionRef = await f.artifacts.putJson({
    ...raw,
    candidateValue: value,
    minRelativeImprovement: 0.07,
    accepted: true,
  });
  const summary = {
    ...f.summary,
    decisionRef,
    facts: {
      ...f.summary.facts,
      candidateMs: value,
      outcome: 'adopted',
      accepted: true,
    },
  };
  const historyRef = await f.artifacts.putJson({
    schemaVersion: 'rsi.operator-history/v1',
    experimentId: 'experiment',
    analysisRef: f.analysisRef,
    summaryRefs: [await f.artifacts.putJson(summary)],
  });
  assert.equal(
    (await readHistory(historyRef, f.context)).summaries[0]!.facts.accepted,
    true,
  );
});

test('history permits a repair chain only after a confirmed candidate failure', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const candidate = await f.facts.read('candidates', 'candidate');
  await f.facts.write('candidates', 'repair', {
    ...candidate,
    ref: 'repair',
    parentRef: 'candidate',
  });
  const measurement = await f.facts.read(
    'measurements',
    'candidate-measurement',
  );
  await f.facts.write('measurements', 'repair-measurement', {
    ...measurement,
    ref: 'repair-measurement',
    callId: 'repair-call',
    candidateRef: 'repair',
  });
  const raw = object(await f.artifacts.readJson(f.summary.decisionRef));
  const decisionRef = await f.artifacts.putJson({
    ...raw,
    measurementRefs: ['baseline', 'repair-measurement'],
  });
  const summary = {
    ...f.summary,
    candidateRefs: ['candidate', 'repair'],
    measurementRefs: ['candidate-measurement', 'repair-measurement'],
    decisionRef,
  };
  const historyRef = await f.artifacts.putJson({
    schemaVersion: 'rsi.operator-history/v1',
    experimentId: 'experiment',
    analysisRef: f.analysisRef,
    summaryRefs: [await f.artifacts.putJson(summary)],
  });
  await assert.rejects(
    readHistory(historyRef, f.context),
    /repair|failed|failure/i,
  );
  object(object(measurement.metrics).candidateValid).value = {
    kind: 'scalar',
    value: 0,
  };
  object(measurement.metrics).latencyMeanMs = {
    definitionRef: 'latency-definition',
    status: 'unavailable',
    value: null,
    reason: 'Candidate failed',
    source: null,
  };
  measurement.coverage = 'partial';
  measurement.comparisonKey = null;
  await f.facts.write('measurements', 'candidate-measurement', measurement);
  assert.equal(
    (await readHistory(historyRef, f.context)).summaries[0]!.facts.outcome,
    'verified-no-gain',
  );
});

test('failed candidate history retains observable task and build identity checks without inventing timing conditions', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const m = await f.facts.read('measurements', 'candidate-measurement');
  object(object(m.metrics).candidateValid).value = { kind: 'scalar', value: 0 };
  object(m.metrics).latencyMeanMs = {
    definitionRef: 'latency-definition',
    status: 'unavailable',
    value: null,
    reason: 'Candidate failed',
    source: null,
  };
  m.coverage = 'partial';
  m.comparisonKey = null;
  const baseline = await f.facts.read('measurements', 'baseline');
  const conditions = object(
    await f.artifacts.readJson(string(object(baseline.conditions).artifactRef)),
  );
  const failed = {
    ...f.summary,
    decisionRef: null,
    facts: {
      outcome: 'verification-failed',
      wasTransformCorrect: false,
      baselineMs: 10,
      candidateMs: null,
      accepted: false,
    },
  };
  const historyRef = await f.artifacts.putJson({
    schemaVersion: 'rsi.operator-history/v1',
    experimentId: 'experiment',
    analysisRef: f.analysisRef,
    summaryRefs: [await f.artifacts.putJson(failed)],
  });
  for (const field of ['taskDigest', 'adapterDigest', 'sdkBuildDigest']) {
    object(m.conditions).artifactRef = await f.artifacts.putJson({
      ...conditions,
      evaluation: null,
      [field]: 'e'.repeat(64),
    });
    await f.facts.write('measurements', 'candidate-measurement', m);
    await assert.rejects(
      readHistory(historyRef, f.context),
      /condition|task|build|identity/i,
    );
  }
  object(m.conditions).artifactRef = await f.artifacts.putJson({
    ...conditions,
    evaluation: null,
  });
  await f.facts.write('measurements', 'candidate-measurement', m);
  assert.equal(
    (await readHistory(historyRef, f.context)).summaries[0]!.facts
      .wasTransformCorrect,
    false,
  );
});

test('a retrieval miss permits a diagnosis-supported technique in the attempt summary', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const read = async (techniqueIds: string[]) =>
    readHistory(
      await f.artifacts.putJson({
        schemaVersion: 'rsi.operator-history/v1',
        experimentId: 'experiment',
        analysisRef: f.analysisRef,
        summaryRefs: [
          await f.artifacts.putJson({ ...f.summary, techniqueIds }),
        ],
      }),
      f.context,
    );
  assert.deepEqual(
    (await read(['loop_invariant_hoisting'])).summaries[0]!.techniqueIds,
    ['loop_invariant_hoisting'],
  );
  await assert.rejects(read(['pass_merge']), /technique|diagnos/i);
});
