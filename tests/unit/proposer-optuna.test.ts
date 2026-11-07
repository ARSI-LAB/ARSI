import test from 'node:test';
import assert from 'node:assert/strict';
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
  FileArtifacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { object, string } from '../../src/shared/json.js';
import {
  parseOptunaConfig,
  validateParameters,
  type OptunaConfig,
} from '../../src/plugins/proposer-optuna/schema.js';
import { createOptunaProposer } from '../../src/plugins/proposer-optuna/service.js';
import { runJsonProcess } from '../../src/plugins/proposer-optuna/worker.js';

const config: OptunaConfig = {
  path: 'tuning.json',
  sampler: { type: 'tpe', seed: 42, options: { startupTrials: 2 } },
  searchSpace: [{ name: 'x', distribution: 'int', low: 1, high: 3 }],
};
const environment = { python: '3.11', optuna: '4.5.0', numpy: '2.2.6' };

test('Optuna validates sampler-specific options and distributions before side effects', () => {
  assert.equal(parseOptunaConfig(config).sampler.type, 'tpe');
  for (const invalid of [
    { ...config, path: '../escape' },
    { ...config, sampler: { type: 'gp' } },
    { ...config, sampler: { type: 'random', options: { startupTrials: 2 } } },
    { ...config, sampler: { type: 'random' }, constraintHandling: 'native' },
    {
      ...config,
      searchSpace: [
        { name: 'x', distribution: 'int', low: 1, high: 4, step: 2 },
      ],
    },
    {
      ...config,
      searchSpace: [
        { name: 'x', distribution: 'float', low: 0.1, high: 0.95, step: 0.1 },
      ],
    },
    {
      ...config,
      searchSpace: [
        { name: 'x', distribution: 'float', low: 0, high: 1, log: true },
      ],
    },
    {
      ...config,
      searchSpace: [{ name: 'x', distribution: 'categorical', values: [{}] }],
    },
    { ...config, searchSpace: [config.searchSpace[0], config.searchSpace[0]] },
    {
      ...config,
      searchSpace: [
        {
          name: 'x',
          distribution: 'float',
          low: -1e308,
          high: 1e308,
          step: 1e-308,
        },
      ],
    },
  ])
    assert.throws(() => parseOptunaConfig(invalid));
});

test('Optuna accepts rounded float grid points without accepting off-step values', () => {
  for (const [low, high, step, value, offStep] of [
    [0.1, 0.9, 1e-9, 0.3996320950000001, 0.3996320955],
    [0.7, 0.9, 1e-9, 0.7749080239999999, 0.7749080245],
    [1e9, 1e9 + 1, 0.1, 1000000000.4, 1000000000.45],
    [9007199254740980, 9007199254740990, 2, 9007199254740982, 9007199254740981],
    [0, 1e-20, 1e-21, 4e-21, 4.5e-21],
  ] as const) {
    const { searchSpace } = parseOptunaConfig({
      ...config,
      searchSpace: [{ name: 'x', distribution: 'float', low, high, step }],
    });
    assert.doesNotThrow(() => validateParameters({ x: value }, searchSpace));
    assert.throws(
      () => validateParameters({ x: offStep }, searchSpace),
      /not aligned with step/,
    );
    for (const outside of [low - step, high + step])
      assert.throws(
        () => validateParameters({ x: outside }, searchSpace),
        /outside searchSpace/,
      );
  }
});

test('Optuna preserves integer step validation at large magnitudes', () => {
  const { searchSpace } = parseOptunaConfig({
    ...config,
    searchSpace: [
      {
        name: 'x',
        distribution: 'int',
        low: 9007199254740980,
        high: 9007199254740990,
        step: 2,
      },
    ],
  });
  assert.doesNotThrow(() =>
    validateParameters({ x: 9007199254740982 }, searchSpace),
  );
  assert.throws(
    () => validateParameters({ x: 9007199254740981 }, searchSpace),
    /not aligned with step/,
  );
});

test('Optuna persists feedback, retains pending proposals and reconstructs after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-optuna-'));
  try {
    const baseline = join(root, 'baseline');
    await mkdir(baseline);
    await writeFile(join(baseline, 'tuning.json'), '{"x":1,"fixed":true}\n');
    const artifacts = new FileArtifacts(join(root, 'artifacts'));
    const workspaces = new FileWorkspaces(join(root, 'workspaces'), artifacts);
    const candidates = new Map<string, Candidate>();
    const initial = {
      ref: 'baseline',
      artifactRef: await artifacts.capture(baseline),
      parentRef: null,
      experimentId: 'e',
    };
    candidates.set(initial.ref, initial);
    const measurements = new Map<string, JsonObject>();
    const context = new RuntimeContext().extend({
      artifacts,
      workspaces,
      experimentId: 'e',
      bindingId: 'proposer',
      signal: new AbortController().signal,
      async readCandidate(ref: string) {
        const value = candidates.get(ref);
        if (!value) throw new Error('Missing candidate');
        return value;
      },
      async readMeasurement(ref: string) {
        const value = measurements.get(ref);
        if (!value) throw new Error('Missing measurement');
        return value;
      },
      async application(input: JsonObject) {
        const edit = await workspaces.read(string(input.editRef));
        const ref = `c${candidates.size}`;
        candidates.set(ref, {
          ref,
          artifactRef: await artifacts.capture(edit.directory),
          parentRef: 'baseline',
          experimentId: 'e',
        });
        return {
          action: 'commit',
          candidateRef: ref,
          status: 'created',
          diffRef: null,
        };
      },
    });
    let calls = 0;
    const runner = async (
      _config: unknown,
      request: JsonObject,
    ): Promise<JsonObject> => {
      calls++;
      const history = request.history;
      if (request.action === 'check') return { environment };
      assert.ok(Array.isArray(history));
      if (history.length) {
        assert.equal(object(history[0]).loss, -10);
        assert.deepEqual(object(history[0]).constraints, [1]);
      }
      return { environment, parameters: { x: history.length + 1 } };
    };
    const proposer = await createOptunaProposer(config, context, runner);
    const initialized = await proposer.execute(
      { action: 'initialize', parent: 'baseline' },
      context,
    );
    assert.equal(initialized.work, null);
    assert.equal(initialized.done, false);
    const suggestion = await proposer.execute(
      { action: 'suggest', stateRef: initialized.stateRef },
      context,
    );
    if (suggestion.work?.kind !== 'evaluation')
      throw new Error('Expected candidate');
    const callCount = calls;
    assert.deepEqual(
      await proposer.execute(
        { action: 'suggest', stateRef: suggestion.stateRef },
        context,
      ),
      suggestion,
    );
    assert.equal(calls, callCount);
    const state = object(await artifacts.readJson(suggestion.stateRef));
    assert.equal(state.experimentId, 'e');
    assert.deepEqual(
      object(state.settings).sampler,
      parseOptunaConfig(config).sampler,
    );
    const candidate = candidates.get(
      suggestion.work.evaluations[0]!.candidateRef,
    )!;
    const snapshot = join(root, 'snapshot');
    await artifacts.materialize(candidate.artifactRef, snapshot);
    assert.deepEqual(
      JSON.parse(await readFile(join(snapshot, 'tuning.json'), 'utf8')),
      { x: 1, fixed: true },
    );
    const definitionRef = await artifacts.putJson({
      id: 'throughput',
      valueKind: 'scalar',
    });
    measurements.set('m', {
      ref: 'm',
      candidateRef: candidate.ref,
      experimentId: 'e',
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'workload',
      metrics: {
        throughput: {
          status: 'available',
          definitionRef,
          value: { kind: 'scalar', value: 10 },
        },
      },
    });
    const decisionRef = await artifacts.putJson({
      kind: 'metric-decision',
      measurementRefs: ['m', 'm'],
      itemId: null,
      metric: 'throughput',
      statistic: null,
      direction: 'maximize',
      definitionRef,
      incumbentValue: 10,
      candidateValue: 10,
      constraints: [
        {
          metric: 'throughput',
          statistic: null,
          definitionRef,
          min: null,
          max: 9,
          incumbentValue: 10,
          candidateValue: 10,
          passed: false,
        },
      ],
      accepted: false,
      tieBreak: 'retain-incumbent',
      reason: 'SLO',
    });
    const feedback = {
      action: 'observe' as const,
      stateRef: suggestion.stateRef,
      workId: suggestion.work.id,
      feedback: {
        kind: 'evaluation' as const,
        measurementRefs: ['m'],
        decisionRef,
      },
    };
    const observed = await proposer.execute(feedback, context);
    for (const invalid of [
      { kind: 'evaluation' as const, measurementRefs: ['m'] },
      { ...feedback.feedback, measurementRefs: ['m', 'm'] },
    ])
      await assert.rejects(
        proposer.execute({ ...feedback, feedback: invalid }, context),
        /one measurement and a decision/,
      );
    assert.deepEqual(
      await proposer.execute(
        { ...feedback, stateRef: observed.stateRef },
        context,
      ),
      observed,
    );
    await assert.rejects(
      proposer.execute({ ...feedback, workId: 'wrong' }, context),
      /trial/i,
    );
    await assert.rejects(
      proposer.execute(
        {
          ...feedback,
          feedback: {
            ...feedback.feedback,
            decisionRef: await artifacts.putJson({}),
          },
        },
        context,
      ),
      /decision/i,
    );
    await assert.rejects(
      proposer.execute(
        { action: 'suggest', stateRef: observed.stateRef },
        context.extend({ experimentId: 'other' }),
      ),
      /identity|scope/i,
    );
    const restored = await createOptunaProposer(config, context, runner);
    const next = await restored.execute(
      { action: 'suggest', stateRef: observed.stateRef },
      context,
    );
    assert.equal(next.work?.kind, 'evaluation');
    if (next.work?.kind === 'evaluation')
      assert.deepEqual(next.work.parameters, { x: 2 });
    let samples = 0;
    const repeated = await createOptunaProposer(config, context, async () => ({
      environment,
      parameters: { x: ++samples <= 32 ? 1 : 2 },
    }));
    const afterDuplicates = await repeated.execute(
      { action: 'suggest', stateRef: observed.stateRef },
      context,
    );
    assert.equal(samples, 33);
    assert.equal(afterDuplicates.work?.kind, 'evaluation');
    if (afterDuplicates.work?.kind === 'evaluation')
      assert.deepEqual(afterDuplicates.work.parameters, { x: 2 });
    const drifted = await createOptunaProposer(config, context, async () => ({
      environment: { ...environment, python: '3.12' },
      parameters: { x: 2 },
    }));
    await assert.rejects(
      drifted.execute(
        { action: 'suggest', stateRef: observed.stateRef },
        context,
      ),
      /environment identity/,
    );
    assert.deepEqual(await readdir(join(root, 'workspaces')), []);
    const changed = await createOptunaProposer(
      { ...config, sampler: { type: 'random' } },
      context,
      runner,
    );
    await assert.rejects(
      changed.execute(
        { action: 'suggest', stateRef: observed.stateRef },
        context,
      ),
      /identity|configuration/i,
    );
    for (const limit of [
      {
        settings: { maxSamplingAttempts: 2 },
        reason: 'sampling-limit',
        suggestions: 2,
      },
      {
        settings: {
          searchSpace: [
            { name: 'x', distribution: 'int' as const, low: 1, high: 1 },
          ],
        },
        reason: 'search-exhausted',
        suggestions: 1,
      },
    ]) {
      let suggestions = 0;
      const bounded = await createOptunaProposer(
        { ...config, ...limit.settings },
        context,
        async (_config, request) => {
          if (request.action === 'suggest') suggestions++;
          return { environment, parameters: { x: 1 } };
        },
      );
      const initial = await bounded.execute(
        { action: 'initialize', parent: 'baseline' },
        context,
      );
      const first = await bounded.execute(
        { action: 'suggest', stateRef: initial.stateRef },
        context,
      );
      if (first.work?.kind !== 'evaluation')
        throw new Error('Expected bounded candidate');
      const count = candidates.size;
      measurements.set('m', {
        ...measurements.get('m')!,
        candidateRef: first.work.evaluations[0]!.candidateRef,
      });
      const complete = await bounded.execute(
        { ...feedback, stateRef: first.stateRef, workId: first.work.id },
        context,
      );
      const stopped = await bounded.execute(
        { action: 'suggest', stateRef: complete.stateRef },
        context,
      );
      assert.equal(stopped.done, true);
      assert.equal(stopped.work, null);
      assert.deepEqual(stopped.result, { reason: limit.reason });
      assert.equal(suggestions, limit.suggestions);
      assert.equal(
        candidates.size,
        count,
        'duplicates and exhaustion do not commit another candidate',
      );
      await bounded.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker bounds failures, propagates cancellation, and reaps the process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-optuna-worker-'));
  try {
    const script = join(root, 'worker.mjs');
    await writeFile(
      script,
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ok:true})));",
    );
    assert.deepEqual(
      await runJsonProcess(
        process.execPath,
        script,
        {},
        new AbortController().signal,
      ),
      { ok: true },
    );
    await writeFile(script, "console.log('invalid');");
    await assert.rejects(
      runJsonProcess(
        process.execPath,
        script,
        {},
        new AbortController().signal,
        2000,
      ),
      /JSON/,
    );
    await writeFile(
      script,
      "process.stderr.write('Specific import failure');process.exit(1);",
    );
    await assert.rejects(
      runJsonProcess(
        process.execPath,
        script,
        { history: 'x'.repeat(1024 * 1024) },
        new AbortController().signal,
        2000,
      ),
      /Specific import failure/,
    );
    await writeFile(script, 'setInterval(()=>{},1000);');
    await assert.rejects(
      runJsonProcess(
        process.execPath,
        script,
        {},
        new AbortController().signal,
        50,
      ),
      /timeout|timed out/i,
    );
    const controller = new AbortController();
    const pending = runJsonProcess(
      process.execPath,
      script,
      {},
      controller.signal,
      2000,
    );
    controller.abort(new Error('Cancelled test'));
    await assert.rejects(pending, /Cancelled test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
