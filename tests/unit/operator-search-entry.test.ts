import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { initializeCampaign } from '../../src/entries/cli/operator-experiments/campaign.js';
import type { JsonObject } from '../../src/contracts/index.js';
import { digest, object, string } from '../../src/shared/json.js';
import * as search from '../../src/entries/cli/operator-experiments/search.js';
import {
  assertSearchConditions,
  finalTimingStable,
  verifySearchCalibration,
} from '../../src/entries/cli/operator-experiments/search.js';

async function inputHelper(name: string, ...args: unknown[]): Promise<unknown> {
  const module: unknown = await import(
    new URL('../../scripts/operator-inputs.mjs', import.meta.url).href
  );
  assert.ok(module && typeof module === 'object');
  const fn: unknown = Reflect.get(module, name);
  if (typeof fn !== 'function') throw new Error(`Missing helper ${name}`);
  return await fn(...args);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-search-entry-'));
  const example = join(root, 'example');
  await cp(
    new URL('../../examples/artifacts/kernel/qianchuan-top3/', import.meta.url),
    example,
    { recursive: true },
  );
  const model = join(root, 'model');
  await mkdir(model);
  await writeFile(join(model, 'weights.bin'), 'fixed model bytes');
  const identity = join(root, 'embedding-identity.json');
  await writeFile(
    identity,
    JSON.stringify({
      schemaVersion: 'rsi.operator-embedding-identity/v1',
      model: { id: 'test-model', revision: 'test-revision' },
      encoding: {
        queryPromptName: 'query',
        normalizeEmbeddings: true,
        device: 'cpu',
        batchSize: 32,
      },
      files: [{ path: 'weights.bin', sha256: 'e'.repeat(64) }],
    }) + '\n',
  );
  const build = join(root, 'build');
  await mkdir(join(build, 'src'), { recursive: true });
  await writeFile(join(build, 'src/index.js'), 'export const build=1;\n');
  const recipe = object(
    parse(await readFile(join(example, 'recipe.sdk.yaml'), 'utf8')),
  );
  recipe.id = 'search-test';
  recipe.policy = {
    ref: 'policy.operator-search',
    config: {
      goal: 'Optimize static source',
      caseIds: ['fixed'],
      maxAttempts: 3,
      repairLimit: 3,
    },
  };
  const bindings = object(recipe.bindings);
  bindings.agent = {
    ref: 'agent.pi',
    config: { api_key: '${MODEL_API_KEY}', retries: 0 },
  };
  bindings.proposer = {
    ref: 'proposer.operator',
    config: {
      agentRef: 'agent',
      task: { directory: './task' },
      embedding: {
        python: '/embedding/python',
        modelDirectory: model,
        identityFile: identity,
      },
    },
  };
  recipe.budget = {
    operations: 256,
    evaluationRuns: 14,
    modelCalls: 32,
    elapsedWallMs: 2400000,
    cleanupReserveMs: 60000,
  };
  const path = join(example, 'recipe.search.yaml');
  await writeFile(path, stringify(recipe));
  const options = {
    kind: 'search',
    buildDirectory: build,
    sdk: { python: '/sdk/python', device: 0, profiling: false },
    embedding: {
      python: '/embedding/python',
      modelDirectory: model,
      identityFile: identity,
    },
    calibration: {
      status: 'failed-noise',
      campaignId: 'calibration',
      comparisonKey: 'a'.repeat(64),
      threshold: null,
      reason: 'Unstable measurements',
      evidence: null,
    },
  };
  return { root, example, model, identity, build, recipe, path, options };
}

test('search snapshots freeze an explicit profiler without discarding the diagnostic protocol', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  object(object(object(f.recipe.bindings).evaluator).config).sdk = {
    ...object(object(object(object(f.recipe.bindings).evaluator).config).sdk),
    profiling: {
      enabled: false,
      collection: 'Default',
      warmup: 25,
      msprofBin: '/recipe/msprof',
    },
  };
  await writeFile(f.path, stringify(f.recipe));
  const options = {
    ...f.options,
    sdk: { ...f.options.sdk, msprofBin: '/isolated/msprof-fixed' },
  };
  const prepared = object(
    await inputHelper(
      'prepareOperatorInputs',
      f.path,
      f.root,
      'profiler',
      options,
    ),
  );
  const frozen = object(
    parse(await readFile(string(prepared.recipePath), 'utf8')),
  );
  assert.deepEqual(
    object(object(object(object(frozen.bindings).evaluator).config).sdk)
      .profiling,
    {
      enabled: false,
      collection: 'Default',
      warmup: 25,
      msprofBin: '/isolated/msprof-fixed',
    },
  );
  const manifest = object(
    JSON.parse(await readFile(string(prepared.manifestPath), 'utf8')),
  );
  assert.equal(
    object(object(manifest.executionParameters).sdk).msprofBin,
    '/isolated/msprof-fixed',
  );
  await assert.rejects(
    inputHelper('prepareOperatorInputs', f.path, f.root, 'profiler', {
      ...options,
      resume: true,
      sdk: { ...options.sdk, msprofBin: '/other/msprof' },
    }),
    /parameters changed/i,
  );
});

test('operator CLIs accept an explicit profiler and retain help without the new flag', async () => {
  const execute = promisify(execFile);
  for (const name of ['run-operator-sdk.mjs', 'run-operator-search.mjs']) {
    const script = new URL(`../../scripts/${name}`, import.meta.url).pathname;
    const original = await execute(process.execPath, [script, '--help']);
    assert.match(original.stdout, /Usage:/);
    const explicit = await execute(process.execPath, [
      script,
      '--msprof-bin',
      '/isolated/msprof-fixed',
      '--help',
    ]);
    assert.match(explicit.stdout, /--msprof-bin/);
    await assert.rejects(
      execute(process.execPath, [script, '--msprof-bin']),
      /msprof-bin.*(value|argument)/i,
    );
  }
});

test('search inputs freeze real Agent bindings and embedding identity without copying model weights', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = object(
    await inputHelper(
      'prepareOperatorInputs',
      f.path,
      f.root,
      'search',
      f.options,
    ),
  );
  const recipe = object(
    parse(await readFile(string(prepared.recipePath), 'utf8')),
  );
  const proposer = object(object(object(recipe.bindings).proposer).config);
  assert.equal(object(recipe.policy).ref, 'policy.operator-search');
  assert.equal(object(object(recipe.bindings).agent).ref, 'agent.pi');
  const embedding = object(proposer.embedding);
  assert.equal(embedding.modelDirectory, f.model);
  assert.notEqual(embedding.identityFile, f.identity);
  assert.equal(
    await readFile(string(embedding.identityFile), 'utf8'),
    await readFile(f.identity, 'utf8'),
  );
  const manifest = object(
    JSON.parse(await readFile(string(prepared.manifestPath), 'utf8')),
  );
  assert.equal(manifest.kind, 'search');
  assert.equal(
    Array.isArray(manifest.files) &&
      manifest.files.some((v) =>
        string(object(v).path).includes('weights.bin'),
      ),
    false,
  );
  await writeFile(f.path, 'invalid changed source recipe');
  assert.deepEqual(
    await inputHelper('prepareOperatorInputs', f.path, f.root, 'search', {
      ...f.options,
      resume: true,
    }),
    prepared,
  );
  await writeFile(f.identity, 'changed model identity');
  await assert.rejects(
    inputHelper('prepareOperatorInputs', f.path, f.root, 'search', {
      ...f.options,
      resume: true,
    }),
    /embedding|identity|parameters/i,
  );
});

test('search snapshots reject scripted Agents, task mismatch, profiling, excessive budgets and nested model weights', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const [name, change] of [
    [
      'scripted',
      (r: typeof f.recipe) => {
        object(object(r.bindings).agent).ref = 'agent.scripted';
      },
    ],
    [
      'task',
      (r: typeof f.recipe) => {
        object(object(object(r.bindings).proposer).config).task = {
          directory: './baseline',
        };
      },
    ],
    [
      'budget',
      (r: typeof f.recipe) => {
        object(r.budget).modelCalls = 33;
      },
    ],
  ] as const) {
    const recipe = structuredClone(f.recipe);
    change(recipe);
    await writeFile(f.path, stringify(recipe));
    await assert.rejects(
      inputHelper('prepareOperatorInputs', f.path, f.root, name, f.options),
    );
  }
  await writeFile(f.path, stringify(f.recipe));
  await assert.rejects(
    inputHelper('prepareOperatorInputs', f.path, f.root, 'profiling', {
      ...f.options,
      sdk: { ...f.options.sdk, profiling: true },
    }),
    /profil/i,
  );
  await assert.rejects(
    inputHelper('prepareOperatorInputs', f.path, f.root, 'weights', {
      ...f.options,
      embedding: {
        ...f.options.embedding,
        modelDirectory: join(f.example, 'baseline'),
      },
    }),
    /model|weight|outside/i,
  );
});

test('search condition matching excludes search-only resources but rejects changed observed task or protocol', () => {
  const evaluation = {
    contract: { caseId: 'fixed' },
    environment: { device: '950PR' },
    protocol: {
      warmup: 5,
      repeat: 20,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels',
    },
  };
  const conditions = {
    mode: 'sdk',
    taskDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    sdkBuildDigest: 'c'.repeat(64),
    evaluation,
  };
  const expected = {
    caseId: 'fixed',
    sourceDigest: 'd'.repeat(64),
    taskDigest: 'a'.repeat(64),
    protocol: {
      warmup: 5,
      repeat: 20,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels',
    },
  };
  assert.doesNotThrow(() =>
    assertSearchConditions(
      {
        sourceDigest: expected.sourceDigest,
        comparisonKey: digest(conditions),
        conditions,
      },
      expected,
    ),
  );
  assert.throws(() =>
    assertSearchConditions(
      {
        sourceDigest: expected.sourceDigest,
        comparisonKey: digest(conditions),
        conditions,
      },
      { ...expected, taskDigest: 'e'.repeat(64) },
    ),
  );
  assert.throws(() =>
    assertSearchConditions(
      {
        sourceDigest: expected.sourceDigest,
        comparisonKey: digest(conditions),
        conditions,
      },
      { ...expected, protocol: { ...expected.protocol, repeat: 100 } },
    ),
  );
});

test('final search timing requires the same source and comparison identity and checks the 5 percent pair threshold', () => {
  const point = (value: number) => ({
    candidateRef: 'candidate',
    comparisonKey: 'same',
    provenance: { sourceDigest: 'source' },
    metrics: {
      candidateValid: {
        status: 'available',
        value: { kind: 'scalar', value: 1 },
      },
      latencyMeanMs: { status: 'available', value: { kind: 'scalar', value } },
    },
  });
  assert.equal(finalTimingStable(point(39), point(41)), true);
  assert.equal(finalTimingStable(point(39), point(41.01)), false);
  assert.equal(
    finalTimingStable(point(39), { ...point(39), candidateRef: 'other' }),
    null,
  );
  assert.equal(
    finalTimingStable(point(39), { ...point(39), comparisonKey: 'other' }),
    null,
  );
  assert.equal(finalTimingStable(point(39), null), null);
});

test('calibration confidence re-audits facts and marks incompatible evidence inapplicable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-search-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new Registry();
  t.after(() => registry.dispose());
  const manager = new Manager({ rootDirectory: root, registry });
  t.after(() => manager.dispose());
  const buildDigest = 'a'.repeat(64);
  await initializeCampaign({
    rootDirectory: root,
    id: 'calibration',
    hostIdentity: 'host',
    inputIdentity: 'baseline-inputs',
    profiling: false,
    preflight: {
      ready: true,
      build: { digest: buildDigest },
      parameters: { python: '/sdk/python', device: 0 },
    },
  });
  await writeFile(
    join(root, '.rsi/operator-calibration/calibration/report.json'),
    JSON.stringify({
      performance: 'passed',
      basicLoop: 'passed',
      recovery: 'verified',
      statistics: { passed: true, threshold: 0.05 },
    }),
  );
  const options = {
    rootDirectory: root,
    campaignId: 'calibration',
    manager,
    hostIdentity: 'host',
    buildDigest,
    expected: {
      caseId: 'fixed',
      sourceDigest: 'b'.repeat(64),
      taskDigest: 'c'.repeat(64),
      protocol: {
        warmup: 5,
        repeat: 20,
        rtol: 0,
        atol: 0,
        timingScope: 'all-device-kernels',
      },
    },
    python: '/sdk/python',
    device: 0,
    minRelativeImprovement: 0.05,
    inspectSnapshot: async () => ({
      recipePath: 'unused',
      identity: 'baseline-inputs',
    }),
  };
  await assert.rejects(
    verifySearchCalibration(options),
    /complete valid real-device evidence/,
  );
  const report = object(
    JSON.parse(
      await readFile(
        join(root, '.rsi/operator-calibration/calibration/report.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(report.performance, 'incomplete');
  assert.equal(
    (await verifySearchCalibration({ ...options, hostIdentity: 'changed' }))
      ?.status,
    'not-applicable',
  );
  assert.equal(
    await verifySearchCalibration({ ...options, campaignId: undefined }),
    null,
  );
  assert.deepEqual(await manager.facts.list('calls'), []);
});

test('model identity preparation records sorted exact file bytes and refuses symbolic links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-model-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = join(root, 'model');
  await mkdir(model);
  await writeFile(join(model, 'z.bin'), 'z');
  await writeFile(join(model, 'a.json'), '{}');
  const output = join(model, 'identity.json');
  const command = new URL(
    '../../scripts/prepare-operator-model.mjs',
    import.meta.url,
  ).pathname;
  const execute = promisify(execFile);
  await execute(process.execPath, [
    command,
    '--model-directory',
    model,
    '--model-id',
    'test/model',
    '--revision',
    'frozen-revision',
    '--out',
    output,
  ]);
  const identity = object(JSON.parse(await readFile(output, 'utf8')));
  assert.equal(identity.schemaVersion, 'rsi.operator-embedding-identity/v1');
  assert.deepEqual(identity.files, [
    { path: 'a.json', sha256: createHash('sha256').update('{}').digest('hex') },
    { path: 'z.bin', sha256: createHash('sha256').update('z').digest('hex') },
  ]);
  await assert.rejects(
    execute(process.execPath, [
      command,
      '--model-directory',
      model,
      '--model-id',
      'test/model',
      '--revision',
      'frozen-revision',
      '--out',
      output,
    ]),
  );
  const { symlink } = await import('node:fs/promises');
  await symlink(join(model, 'z.bin'), join(model, 'link'));
  await assert.rejects(
    execute(process.execPath, [
      command,
      '--model-directory',
      model,
      '--model-id',
      'test/model',
      '--revision',
      'frozen-revision',
      '--out',
      join(root, 'other.json'),
    ]),
    /symlink|ordinary/i,
  );
});

test('search snapshots allow generation without calibration and preserve absent confidence evidence', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = object(
    await inputHelper('prepareOperatorInputs', f.path, f.root, 'uncalibrated', {
      ...f.options,
      calibration: undefined,
    }),
  );
  const recipe = object(
    parse(await readFile(string(prepared.recipePath), 'utf8')),
  );
  assert.equal(
    object(object(object(recipe.bindings).proposer).config).qualification,
    undefined,
  );
});

test('search confidence keeps observed gains pending without calibration or with an unstable independent retest', () => {
  const point = (value: number, candidate = 'optimized') => ({
    candidateRef: candidate,
    comparisonKey: 'same',
    provenance: { sourceDigest: candidate },
    metrics: {
      candidateValid: {
        status: 'available',
        value: { kind: 'scalar', value: 1 },
      },
      latencyMeanMs: { status: 'available', value: { kind: 'scalar', value } },
    },
  });
  const baseline = point(100, 'baseline'),
    best = point(90);
  const assess = (
    calibration: search.SearchCalibration | null,
    final: JsonObject | null,
  ) => search.assessSearchConfidence(calibration, baseline, best, final, 0.02);
  const noCalibration = assess(null, point(91));
  assert.equal(noCalibration.observedImprovement, true);
  assert.equal(noCalibration.performanceQualified, false);
  assert.equal(noCalibration.improvementStatus, 'pending');
  const calibration: search.SearchCalibration = {
    status: 'passed',
    campaignId: 'calibration',
    comparisonKey: 'same',
    threshold: 0.05,
    evidence: null,
    reason: null,
  };
  assert.equal(assess(calibration, point(91)).improvementStatus, 'verified');
  assert.equal(assess(calibration, point(99)).improvementStatus, 'pending');
  assert.equal(
    assess(
      { ...calibration, status: 'failed-noise', threshold: null },
      point(91),
    ).improvementStatus,
    'pending',
  );
  assert.equal(
    assess({ ...calibration, comparisonKey: 'changed' }, point(91))
      .performanceQualified,
    false,
  );
  assert.equal(assess(calibration, null).improvementStatus, 'invalid');
  assert.equal(
    search.assessSearchConfidence(
      calibration,
      baseline,
      baseline,
      point(100, 'baseline'),
      0.02,
    ).improvementStatus,
    'not-observed',
  );
});
