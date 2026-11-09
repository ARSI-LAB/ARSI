import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { parseMetricRecords } from '../../web/api/observation-client.js';
import {
  scoreGroups,
  scorePoints,
} from '../../web/features/experiments/charts/metric-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { normalizeEvaluation as normalizeAgentbench } from '../../src/plugins/evaluator-agentbench/measurement.js';
import { normalizeEvaluation as normalizeInferencebench } from '../../src/plugins/evaluator-inferencebench/measurement.js';
import { meanReward } from '../../src/plugins/evaluator-agentbench/metrics.js';
import { object, string } from '../../src/shared/json.js';
import { agentbenchDefinition } from '../../src/plugins/evaluator-agentbench/index.js';
import { inferencebenchDefinition } from '../../src/plugins/evaluator-inferencebench/index.js';
import { createAgentbench } from '../../src/plugins/evaluator-agentbench/service.js';
import { createInferencebench } from '../../src/plugins/evaluator-inferencebench/service.js';
import type { AgentbenchConfig } from '../../src/plugins/evaluator-agentbench/schema.js';
import type { EvaluatorConfig } from '../../src/plugins/evaluator-inferencebench/schema.js';
import type { EvaluatorRunner } from '../../src/plugins/shared/evaluator-adapter/sdk.js';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
} from '../../src/contracts/index.js';
type EvaluatorKind = 'agentbench' | 'inferencebench';
function evaluatorWithRunner(
  kind: EvaluatorKind,
  runner: EvaluatorRunner,
): OperationDefinition {
  if (kind === 'inferencebench')
    return {
      ...inferencebenchDefinition,
      create: (config: EvaluatorConfig, services) =>
        createInferencebench(config, services, runner),
    };
  return {
    ...agentbenchDefinition,
    create: (config: AgentbenchConfig, services) =>
      createAgentbench(config, services, runner),
  };
}
function context(directory: string): RuntimeContext {
  return new RuntimeContext().extend({
    directory,
    experimentId: 'exp',
    callId: 'call',
    bindingId: 'evaluator',
    idempotencyKey: 'call',
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
  });
}
function harness(directory: string): {
  services: RuntimeContext;
  stored: Map<string, unknown>;
  measurements: JsonObject[];
} {
  const stored = new Map<string, unknown>();
  const measurements: JsonObject[] = [];
  const services: RuntimeContext = new RuntimeContext().extend({
    rootDirectory: directory,
    dataDirectory: directory,
    artifacts: {
      putJson: async (v) => {
        const ref = `artifact:${stored.size}`;
        stored.set(ref, v);
        return ref;
      },
      readJson: async (ref) => {
        const v = stored.get(ref);
        return JSON.parse(JSON.stringify(v));
      },
      capture: async () => 'artifact:tree',
      materialize: async () => {},
    },
    facts: {
      read: async () => ({}),
      write: async () => {},
      list: async () => [],
    },
    workspaces: {
      create: async () => ({ ref: 'ws', directory, parentCandidateRef: null }),
      read: async () => ({ ref: 'ws', directory, parentCandidateRef: null }),
      release: async () => {},
    },
    readCandidate: async () => ({
      ref: 'candidate:a',
      artifactRef: 'artifact:a',
      parentRef: null,
      experimentId: 'exp',
    }),
    recordCandidate: async () => 'candidate:a',
    recordMeasurement: async (m) => {
      measurements.push(m);
      return 'measurement:one';
    },
    readMeasurement: async () => ({}),
    application: async () => ({}),
    applicationMetadata: async () => ({}),
    invokeAgent: async () => ({}),
    readEvidence: async () => [],
    invoke: async () => ({}),
    charge: async () => {},
    withInstance: async (_candidate, _capability, use) =>
      use({
        kind: 'agentbundle',
        directory: join(directory, 'bundle'),
        bundleDigest: 'sha256:bundle',
        artifactDigest: 'artifact:a',
      }),
  });
  return { services, stored, measurements };
}
function snapshot(kind = 'quality'): JsonObject {
  return {
    digest: 'snapshot',
    run: {
      runId: 'native',
      evaluationKind: kind,
      status: 'completed',
      taskIds: ['task/a'],
      source: { source: 'fixture', revision: 'rev', files: [], metadata: {} },
      identity: {
        evaluator: { name: 'test', version: '1' },
        runtime: { node: '24', platform: 'linux', arch: 'x64' },
      },
      solverProvenance: {
        harness: 'dsh',
        harnessVersion: '1',
        cliVersion: '1',
      },
      pluginVersions: {},
      startedAt: '2026-10-25T00:00:00.000Z',
      finishedAt: '2026-10-25T00:00:01.000Z',
    },
    records: [
      {
        key: { runId: 'native', taskId: 'task/a', attemptId: 'attempt1' },
        executionStatus: 'completed',
        scoreStatus: kind === 'quality' ? 'valid' : 'not-applicable',
        cleanupStatus: 'cleaned',
        solve: {
          finalText: 'answer',
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
        verdict: { passed: false, details: {} },
        errors: [],
        collection: { trajectory: 'missing', artifacts: 'not-produced' },
      },
    ],
    pendingTaskIds: [],
  };
}
for (const kind of ['agentbench', 'inferencebench'] as const) {
  test(`${kind} maps SDK execution outcomes independently of answer correctness`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rsi-item-status-'));
    try {
      const { services, stored, measurements } = harness(directory);
      const snap = snapshot(kind === 'agentbench' ? 'quality' : 'performance');
      assert.ok(Array.isArray(snap.records));
      const original = object(snap.records[0]);
      const outcomes = [
        ['completed', 'succeeded'],
        ['agent_timeout', 'failed'],
        ['failed', 'failed'],
        ['cancelled', 'cancelled'],
        ['unrecognized', 'unknown'],
        [null, 'unknown'],
      ] as const;
      snap.records = outcomes.map(([executionStatus], index) => {
        const record = structuredClone(original);
        record.key = {
          runId: 'native',
          taskId: `task/${index}`,
          attemptId: `attempt${index}`,
        };
        if (executionStatus === null) delete record.executionStatus;
        else record.executionStatus = executionStatus;
        record.scoreStatus =
          kind === 'inferencebench'
            ? 'not-applicable'
            : executionStatus === 'completed' ||
                executionStatus === 'agent_timeout'
              ? 'valid'
              : 'invalid';
        record.verdict =
          executionStatus === 'completed'
            ? kind === 'agentbench'
              ? { passed: false, score: 0.847, details: {} }
              : { passed: null, details: {} }
            : null;
        return record;
      });
      const taskIds = outcomes.map((_, index) => `task/${index}`);
      object(snap.run).taskIds = taskIds;
      const normalize =
        kind === 'agentbench' ? normalizeAgentbench : normalizeInferencebench;
      const call = context(directory).extend(services);
      const native = {
        services: { default: { model: 'fixture', base_url: 'http://model' } },
        benchmark: {
          name: kind === 'agentbench' ? 'workbuddy' : 'agentx',
          solver: {
            name: kind === 'agentbench' ? 'agentbundle' : 'agentx-replay',
          },
        },
      };
      await normalize(
        native,
        { candidateRef: 'candidate:a', taskIds },
        {},
        { kind: 'local', exitCode: 0, snapshot: snap },
        call,
      );
      const measurement = measurements[0]!;
      const list = object(stored.get(string(measurement.itemsRef)));
      assert.ok(Array.isArray(list.items));
      const items = list.items.map((item) => object(item));
      assert.deepEqual(
        items.map((item) => item.status),
        outcomes.map(([, expected]) => expected),
      );
      assert.equal(measurement.status, 'succeeded');
      for (const [index, item] of items.entries()) {
        const details = object(
          stored.get(string(object(item.details).artifactRef)),
        );
        const selected = object(details.selected);
        assert.equal(selected.status, outcomes[index]![0] ?? 'unknown');
        assert.equal(selected.executionStatus, outcomes[index]![0]);
      }
      if (kind === 'agentbench') {
        const first = items[0]!;
        assert.deepEqual(object(object(first.metrics).score).value, {
          kind: 'scalar',
          value: 0.847,
        });
        const feedback = object(
          stored.get(string(object(first.evaluation).artifactRef)),
        );
        assert.equal(feedback.passed, false);
        assert.equal(feedback.scoreStatus, 'valid');
      }

      const cancellation = new AbortController();
      cancellation.abort();
      call.signal = cancellation.signal;
      await normalize(
        native,
        { candidateRef: 'candidate:a', taskIds },
        {},
        { kind: 'local', exitCode: 0, snapshot: snap },
        call,
      );
      const cancelled = measurements[1]!;
      const cancelledList = object(stored.get(string(cancelled.itemsRef)));
      assert.ok(Array.isArray(cancelledList.items));
      assert.ok(
        cancelledList.items.every(
          (item) => object(item).status === 'cancelled',
        ),
      );
      assert.equal(cancelled.status, 'cancelled');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('agentbench retains finalized verifier timeouts as failed data and reconciles without rerunning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-verifier-timeout-'));
  try {
    const { services, measurements, stored } = harness(directory);
    const call = context(directory).extend(services);
    const snap = snapshot();
    object(snap.run).status = 'error';
    Object.assign(object((snap.records as JsonValue[])[0]), {
      executionStatus: 'failed',
      scoreStatus: 'invalid',
      cleanupStatus: 'cleaned',
      verdict: null,
      errors: [
        {
          phase: 'verify',
          code: 'VERIFY_TIMEOUT',
          category: 'verifier',
          scope: 'attempt',
          retryable: false,
          action: 'finalize',
        },
      ],
    });
    let evaluations = 0;
    let acquisitions = 0;
    const charges: string[] = [];
    call.charge = async (metric) => {
      charges.push(metric);
    };
    call.withInstance = async (_candidate, _capability, use) => {
      acquisitions++;
      return use({
        kind: 'agentbundle',
        directory: join(directory, 'bundle'),
        bundleDigest: 'sha256:bundle',
        artifactDigest: 'artifact:a',
      });
    };
    const op = await createAgentbench(
      {
        services: { default: { model: 'fixture', base_url: 'http://model' } },
        benchmark: { name: 'workbuddy' },
      },
      services,
      async () => {
        evaluations++;
        return { kind: 'local', exitCode: 1, snapshot: snap };
      },
    );
    const input = { candidateRef: 'candidate:a', taskIds: ['task/a'] };
    assert.deepEqual(await op.execute(input, call), {
      measurementRef: 'measurement:one',
    });
    const measurement: JsonObject = {
      ...measurements[0]!,
      ref: 'measurement:one',
    };
    assert.equal(measurement.status, 'failed');
    assert.equal(
      object(object(measurement.metrics).score).status,
      'unavailable',
    );
    assert.equal(object(object(measurement.metrics).score).value, null);
    const receipt = {
      callId: 'call',
      experimentId: 'exp',
      status: 'failed',
      measurementRef: 'measurement:one',
    };
    call.readMeasurement = async () => measurement as never;
    let childStatus = 'succeeded';
    let instanceStatus = 'released';
    call.facts = {
      list: async (): Promise<JsonObject[]> => [
        {
          experimentId: 'exp',
          parentCallId: 'call',
          status: 'succeeded',
          bindingId: '_application',
          input: { action: 'acquire', instanceId: 'owned' },
          output: { instanceId: 'owned' },
        },
        {
          experimentId: 'exp',
          parentCallId: 'call',
          status: childStatus,
          bindingId: '_application',
          input: { action: 'release', instanceId: 'owned' },
          output: { instanceId: 'owned', status: 'released' },
        },
      ],
      read: async () => ({
        status: instanceStatus,
        experimentId: 'exp',
        candidateRef: 'candidate:a',
      }),
      write: async () => {
        throw new Error('Reconciliation must be read-only');
      },
    };
    assert.equal(typeof op.canRetry, 'function');
    assert.equal(
      await op.canRetry!(input, { ...receipt, status: 'unknown' }, call),
      false,
    );
    assert.equal(
      await op.canRetry!({ ...input, candidateRef: 'other' }, receipt, call),
      false,
    );
    childStatus = 'unknown';
    assert.equal(await op.canRetry!(input, receipt, call), false);
    childStatus = 'succeeded';
    instanceStatus = 'ready';
    assert.equal(await op.canRetry!(input, receipt, call), false);
    instanceStatus = 'released';
    assert.equal(await op.canRetry!(input, receipt, call), true);
    assert.deepEqual(await op.execute(input, call), {
      measurementRef: 'measurement:one',
    });
    assert.equal(evaluations, 1);
    assert.equal(acquisitions, 1);
    assert.deepEqual(charges, ['evaluationRuns']);
    assert.equal(measurements.length, 1);
    assert.equal(measurement.status, 'failed');
    assert.ok(stored.size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agentbench resumes a pre-enumeration preparation failure with a fresh owned instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-preparation-retry-'));
  try {
    const { services, measurements, stored } = harness(directory);
    const call = context(directory).extend(services);
    const failed = snapshot();
    Object.assign(object(failed.run), {
      status: 'error',
      failure: {
        code: 'ENV_PREPARATION_FAILED',
        phase: 'prepare',
        category: 'infrastructure',
        action: 'finalize',
      },
    });
    failed.records = [];
    failed.pendingTaskIds = ['task/a'];
    let runs = 0;
    const charges: string[] = [];
    call.charge = async (metric) => {
      charges.push(metric);
    };
    const op = await createAgentbench(
      {
        services: { default: { model: 'fixture', base_url: 'http://model' } },
        benchmark: { name: 'workbuddy' },
      },
      services,
      async () => {
        if (++runs === 1)
          throw Object.assign(new Error('Docker connection EOF'), {
            name: 'EvaluatorRunError',
            phase: 'enumerate',
            result: { kind: 'local', exitCode: 1, snapshot: failed },
          });
        return { kind: 'local', exitCode: 0, snapshot: snapshot() };
      },
    );
    const input = { candidateRef: 'candidate:a', taskIds: ['task/a'] };
    await assert.rejects(op.execute(input, call), /Docker connection EOF/);
    const measurement: JsonObject = {
      ...measurements[0]!,
      ref: 'measurement:one',
    };
    const receipt = {
      callId: 'call',
      experimentId: 'exp',
      status: 'failed',
      measurementRef: 'measurement:one',
    };
    call.readMeasurement = async () => measurement as never;
    let released = false;
    call.facts = {
      list: async (): Promise<JsonObject[]> => [
        {
          parentCallId: 'call',
          experimentId: 'exp',
          status: 'succeeded',
          bindingId: '_application',
          input: { action: 'acquire' },
          output: { instanceId: 'old' },
        },
        {
          parentCallId: 'call',
          experimentId: 'exp',
          status: 'succeeded',
          bindingId: '_application',
          input: { action: 'release', instanceId: 'old' },
          output: { status: 'released' },
        },
      ],
      read: async () => ({
        status: released ? 'released' : 'ready',
        experimentId: 'exp',
        candidateRef: input.candidateRef,
      }),
      write: async () => {
        throw new Error('read-only recovery');
      },
    };
    assert.equal(await op.canRetry!(input, receipt, call), false);
    released = true;
    assert.equal(
      await op.canRetry!(input, { ...receipt, status: 'unknown' }, call),
      false,
    );
    assert.equal(
      await op.canRetry!({ ...input, taskIds: ['other'] }, receipt, call),
      false,
    );
    const provenance = object(
      stored.get(object(measurement.provenance).artifactRef as string),
    );
    const saved = object(
      stored.get(object(provenance.nativeResult).resultRef as string),
    );
    const savedSnapshot = object(saved.snapshot);
    const originalSnapshot = structuredClone(savedSnapshot);
    for (const patch of [
      { records: snapshot().records },
      { pendingTaskIds: [] },
      { run: { ...object(savedSnapshot.run), status: 'running' } },
      {
        run: {
          ...object(savedSnapshot.run),
          failure: { code: 'VERIFY_TIMEOUT', phase: 'verify' },
        },
      },
    ]) {
      Object.assign(savedSnapshot, originalSnapshot, patch);
      assert.equal(await op.canRetry!(input, receipt, call), false);
    }
    Object.assign(savedSnapshot, originalSnapshot);
    assert.equal(await op.canRetry!(input, receipt, call), true);
    call.withInstance = async () => {
      throw new Error('Must not reuse released acquisition');
    };
    const actions: string[] = [];
    let acquired = '';
    call.application = async (request): Promise<JsonObject> => {
      actions.push(String(request.action));
      if (request.action === 'acquire') {
        acquired = String(request.instanceId);
        assert.notEqual(acquired, 'old');
        return {
          action: 'acquire',
          instanceId: acquired,
          execution: {
            directory: join(directory, 'fresh-bundle'),
            bundleDigest: 'sha256:bundle',
            artifactDigest: 'artifact:a',
          },
        };
      }
      assert.equal(request.action, 'release');
      assert.equal('instanceId' in request && request.instanceId, acquired);
      return { action: 'release', instanceId: acquired, status: 'released' };
    };
    await op.execute(input, call);
    assert.deepEqual(actions, ['acquire', 'release']);
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
    assert.equal(runs, 2);
    assert.equal(measurements.length, 2);
    assert.equal(measurements[0]!.status, 'failed');
    assert.equal(measurements[1]!.status, 'succeeded');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native meanReward is unavailable for missing, nonfinite, or unsourced values', async () => {
  const { services } = harness('/unused');
  const unavailable: (JsonObject | null)[] = [
    null,
    {},
    { meanReward: null },
    { meanReward: '0.625' },
    { meanReward: NaN },
    { meanReward: Infinity },
    { meanReward: -Infinity },
  ];
  for (const summary of unavailable) {
    const metric = await meanReward(
      services.artifacts,
      summary,
      'artifact:metrics',
    );
    assert.equal(metric.status, 'unavailable');
    assert.equal(metric.value, null);
    assert.equal(typeof metric.reason, 'string');
  }
  const unsourced = await meanReward(
    services.artifacts,
    { meanReward: 0.625 },
    null,
  );
  assert.equal(unsourced.status, 'unavailable');
  assert.equal(unsourced.value, null);
  for (const value of [0, -0.25, 1.5]) {
    const metric = await meanReward(
      services.artifacts,
      { meanReward: value },
      'artifact:metrics',
    );
    assert.equal(metric.status, 'available');
    assert.deepEqual(metric.value, { kind: 'scalar', value });
  }
});
test('quality comparisons ignore CPU placement only for known capacity and preserve native provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-cpu-comparison-'));
  try {
    const { services, stored, measurements } = harness(directory);
    async function evaluate(
      kind: EvaluatorKind,
      effective: JsonObject,
      requested: JsonObject = { cpus: 2, memory: '4096m' },
      baseImage: JsonObject = {
        id: 'sha256:fixed',
        reference: 'fixture:fixed',
      },
    ): Promise<JsonObject> {
      const snap = snapshot(kind === 'agentbench' ? 'quality' : 'performance');
      const records = snap.records as JsonObject[];
      records[0]!.environments = {
        solve: {
          kind: 'docker',
          platform: 'linux/amd64',
          baseImage,
          runtimes: [{ name: 'node', version: '24' }],
          resources: { requested, effective },
        },
        verify: null,
      };
      const call = context(directory);
      call.callId = `cpu-${measurements.length}`;
      await (
        kind === 'agentbench' ? normalizeAgentbench : normalizeInferencebench
      )(
        {
          services: { default: { model: 'fixture', base_url: 'http://model' } },
          benchmark: {
            name: kind === 'agentbench' ? 'workbuddy' : 'agentx',
            solver: {
              name: kind === 'agentbench' ? 'agentbundle' : 'agentx-replay',
            },
          },
        },
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        { resources: { verified: true } },
        { kind: 'local', exitCode: 0, snapshot: snap },
        call.extend(services),
      );
      const result = measurements.at(-1)!;
      const provenance = stored.get(
        (result.provenance as JsonObject).artifactRef as string,
      ) as JsonObject;
      const native = stored.get(
        (provenance.nativeResult as JsonObject).resultRef as string,
      ) as JsonObject;
      assert.deepEqual(
        native.snapshot,
        snap,
        'native provenance retains the actual CPU placement',
      );
      assert.equal(result.status, 'succeeded');
      assert.equal(result.coverage, 'complete');
      assert.equal(typeof result.comparisonKey, 'string');
      return result;
    }
    const resources: JsonObject = {
      cpus: 2,
      availableCpus: 2,
      cpusetCpus: '0,1',
      memoryBytes: 4294967296,
    };
    const before = await evaluate('agentbench', resources);
    const moved = await evaluate('agentbench', {
      ...resources,
      cpusetCpus: '8,9',
    });
    assert.equal(
      before.comparisonKey,
      moved.comparisonKey,
      'equal quality capacity remains comparable after CPU placement changes',
    );
    for (const changed of [
      { ...resources, availableCpus: 1 },
      { ...resources, cpus: 1 },
      { ...resources, memoryBytes: 2147483648 },
    ]) {
      assert.notEqual(
        before.comparisonKey,
        (await evaluate('agentbench', changed)).comparisonKey,
      );
    }
    assert.notEqual(
      before.comparisonKey,
      (await evaluate('agentbench', resources, { cpus: 3, memory: '4096m' }))
        .comparisonKey,
    );
    assert.notEqual(
      before.comparisonKey,
      (
        await evaluate('agentbench', resources, undefined, {
          id: 'sha256:other',
          reference: 'fixture:fixed',
        })
      ).comparisonKey,
    );
    for (const availableCpus of [undefined, null, 0, -1, 1.5, '2']) {
      const unknown = { ...resources };
      delete unknown.availableCpus;
      if (availableCpus !== undefined) unknown.availableCpus = availableCpus;
      assert.notEqual(
        (await evaluate('agentbench', unknown)).comparisonKey,
        (await evaluate('agentbench', { ...unknown, cpusetCpus: '8,9' }))
          .comparisonKey,
        'unknown CPU capacity retains placement differences',
      );
    }
    assert.notEqual(
      (await evaluate('inferencebench', resources)).comparisonKey,
      (await evaluate('inferencebench', { ...resources, cpusetCpus: '8,9' }))
        .comparisonKey,
      'performance measurements retain exact CPU placement',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('agentbench injects native path/taskIds while preserving solver config, stores typed unsuccessful-answer measurement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-eval-'));
  try {
    const { services, stored, measurements } = harness(directory);
    let native: JsonObject = {};
    const def = evaluatorWithRunner('agentbench', async (options) => {
      native = parse(await readFile(options.configPath, 'utf8'));
      const runDir = join(directory, 'native');
      await mkdir(runDir);
      await writeFile(
        join(runDir, 'metrics.json'),
        JSON.stringify({
          snapshotDigest: 'snapshot',
          revision: 1,
          metrics: {
            'success-rate': {
              rate: 0,
              passed: 0,
              denominator: 2,
              selected: 2,
              invalid: 0,
              verified: 2,
              pending: 0,
            },
            'harbor-score': { meanReward: 0.625, denominator: 4 },
          },
        }),
      );
      const result = snapshot();
      (result.run as JsonObject).taskIds = ['task/a', 'task/b'];
      const records = result.records as JsonObject[];
      records[0]!.scoreStatus = 'valid';
      records[0]!.verdict = {
        passed: false,
        score: 0.25,
        details: { rewards: { custom: 2 } },
      };
      const second = structuredClone(records[0]);
      (second.key as JsonObject).taskId = 'task/b';
      second.verdict = {
        passed: false,
        score: 0.75,
        details: { rewards: { custom: 4 } },
      };
      records.push(second);
      return {
        kind: 'local',
        exitCode: 0,
        runId: 'native',
        runDirectory: runDir,
        reportPath: null,
        snapshot: result,
      };
    });
    const op = await def.create(
      {
        services: {
          default: {
            model: 'model',
            base_url: '${MODEL_ENDPOINT}',
            api_key: '${MODEL_API_KEY}',
            contextWindow: 8192,
          },
        },
        benchmark: {
          name: 'workbuddy',
          scenario: 'office',
          solver: { name: 'agentbundle', config: { maxTokens: 123 } },
        },
        hardware: 'gpu',
        run: { sampling: { strategy: 'random', seed: 2 }, maxTasks: 2 },
      },
      services,
    );
    assert.deepEqual(
      await op.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/b', 'task/a'] },
        context(directory).extend(services),
      ),
      { measurementRef: 'measurement:one' },
    );
    assert.deepEqual((native.run as JsonObject).taskIds, ['task/b', 'task/a']);
    assert.equal((native.run as JsonObject).maxTasks, null);
    assert.equal((native.run as JsonObject).sampling, undefined);
    assert.equal((native.run as JsonObject).preparation, undefined);
    const solver = (native.benchmark as JsonObject).solver as JsonObject;
    assert.equal((solver.config as JsonObject).maxTokens, 123);
    assert.equal((solver.config as JsonObject).path, join(directory, 'bundle'));
    assert.equal(measurements[0].status, 'succeeded');
    assert.equal(measurements[0].coverage, 'complete');
    const provenance = object(
      stored.get(object(measurements[0].provenance).artifactRef as string),
    );
    const savedConfig = object(provenance.configuration);
    assert.equal(savedConfig.hardware, 'gpu');
    assert.equal(
      object(object(savedConfig.services).default).contextWindow,
      8192,
    );
    const metric = (measurements[0].metrics as JsonObject)
      .successRate as JsonObject;
    assert.deepEqual(metric.value, { kind: 'scalar', value: 0 });
    const metrics = measurements[0].metrics as JsonObject;
    const meanReward = metrics.meanReward as JsonObject;
    assert.ok(
      meanReward,
      'native Harbor meanReward is exposed as a named metric',
    );
    assert.equal(meanReward.status, 'available');
    assert.deepEqual(meanReward.value, { kind: 'scalar', value: 0.625 });
    const source = meanReward.source as JsonObject;
    assert.equal(source.pointer, '/metrics/harbor-score/meanReward');
    const envelope = stored.get(source.artifactRef as string) as JsonObject;
    assert.deepEqual((envelope.metrics as JsonObject)['harbor-score'], {
      meanReward: 0.625,
      denominator: 4,
    });
    const definition = stored.get(
      meanReward.definitionRef as string,
    ) as JsonObject;
    assert.equal(definition.mapping, 'harbor-score.meanReward');
    assert.deepEqual((metrics.score as JsonObject).value, {
      kind: 'scalar',
      value: 0.5,
    });
    assert.deepEqual((metrics['reward.custom'] as JsonObject).value, {
      kind: 'scalar',
      value: 3,
    });
    assert.ok(stored.size > 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('partial SDK error is archived and thrown, never returned as a successful measurement output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-eval-'));
  try {
    const { services, measurements } = harness(directory);
    const partial = snapshot();
    (partial.run as JsonObject).status = 'error';
    const def = evaluatorWithRunner('agentbench', async () => {
      throw Object.assign(new Error('failed'), {
        phase: 'collect',
        result: {
          kind: 'local',
          exitCode: 1,
          runId: 'native',
          snapshot: partial,
          runDirectory: null,
          reportPath: null,
        },
      });
    });
    const op = await def.create(
      {
        services: { default: { model: 'm', base_url: 'http://model' } },
        benchmark: { name: 'workbuddy' },
      },
      services,
    );
    await assert.rejects(
      op.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        context(directory).extend(services),
      ),
      /failed/,
    );
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0].status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('AgentX preserves point distributions and official comparability, without an invented run average', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-agentx-'));
  try {
    const { services, stored, measurements } = harness(directory);
    services.withInstance = async (_c, _p, use) =>
      use({
        kind: 'inference-endpoint',
        baseUrl: 'http://127.0.0.1:12345/v1',
        model: 'served-model',
        credentialRef: 'MODEL_API_KEY',
      });
    let native: JsonObject = {};
    const snap = snapshot('performance');
    (snap.run as JsonObject).taskIds = [
      'agentx-256k-replay-c1',
      'agentx-256k-replay-c4',
    ];
    snap.records = [1, 4].map((n) => ({
      key: {
        runId: 'native',
        taskId: `agentx-256k-replay-c${n}`,
        attemptId: `a${n}`,
      },
      executionStatus: 'completed',
      scoreStatus: 'not-applicable',
      cleanupStatus: 'cleaned',
      solve: {
        finalText: '',
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        observations: {
          schemaVersion: 1,
          kind: 'agentx',
          harnessVersion: '1.0.7',
          upstreamInvalidReasons: [],
          workload: {
            schemaVersion: 1,
            kind: 'agentx',
            variant: '256k',
            mode: 'replay',
            concurrency: n,
            durationSeconds: 600,
            seed: 42,
            dataset: 'fixture',
            loader: 'fixture',
            revision: 'rev',
            sha256: 'trace',
            tracePath: 'input/traces.jsonl',
            traceCount: 16,
          },
          lexicon: { source: 'fixture', revision: '1', digest: 'lex' },
          profiling: {
            outputThroughput: {
              unit: 'tokens/sec',
              mean: n * 100,
              p50: null,
              p95: null,
              p99: null,
              count: null,
            },
          },
          warmup: {},
          comparable: false,
          incomparableReasons: ['full_trace_replay'],
          upstreamSubmissionValid: null,
        },
      },
      verdict: { passed: null, details: {} },
      errors: [],
      collection: { trajectory: 'not-produced', artifacts: 'not-produced' },
    }));
    const def = evaluatorWithRunner('inferencebench', async (options) => {
      native = parse(await readFile(options.configPath, 'utf8'));
      return {
        kind: 'local',
        exitCode: 0,
        runId: 'native',
        runDirectory: null,
        reportPath: null,
        snapshot: snap,
      };
    });
    const op = await def.create(
      {
        benchmark: {
          name: 'agentx',
          scenario: 'replay',
          config: { concurrency: [1, 4], traceCount: 16, durationSeconds: 600 },
          solver: { config: { tokenizer: 'fixture' } },
        },
      },
      services,
    );
    await op.execute(
      { candidateRef: 'candidate:a' },
      context(directory).extend(services),
    );
    assert.equal(
      ((native.services as JsonObject).default as JsonObject).base_url,
      'http://127.0.0.1:12345/v1',
    );
    assert.deepEqual(measurements[0].metrics, {});
    // Exercise the current adapter output through the same query/client/chart path as the UI.
    const queries = new ObservationQueries(
      {
        read: async () => ({ id: 'exp', status: 'succeeded' }),
        list: async (kind) => (kind === 'measurements' ? measurements : []),
      },
      services.artifacts,
    );
    const observed = parseMetricRecords(await queries.metricRecords('exp'));
    assert.equal(observed.total, 2);
    assert.ok(
      observed.items.every(
        (item) => item.item?.subjectKind === 'workload-point',
      ),
    );
    const groups = scoreGroups(observed.items);
    const throughput = groups.filter(
      (group) => group.name === 'outputThroughput',
    );
    assert.equal(throughput.length, 2);
    assert.deepEqual(
      throughput
        .map((group) => scorePoints(observed.items, group, 'mean')[0]?.value)
        .sort((a, b) => Number(a) - Number(b)),
      [100, 400],
    );

    const list = stored.get(measurements[0].itemsRef as string) as {
      items: JsonObject[];
    };
    assert.equal(list.items.length, 2);
    assert.deepEqual(
      ((list.items[1].metrics as JsonObject).outputThroughput as JsonObject)
        .value,
      {
        kind: 'distribution',
        count: null,
        mean: 400,
        p50: null,
        p95: null,
        p99: null,
      },
    );
    const details = stored.get(
      (list.items[1].details as JsonObject).artifactRef as string,
    ) as JsonObject;
    assert.equal((details.summary as JsonObject).comparable, false);
    if (!Array.isArray(snap.records))
      throw new Error('Expected fixture records');
    const observations = object(
      object(object(snap.records[0]).solve).observations,
    );
    object(observations.workload).concurrency = 0;
    await assert.rejects(
      op.execute(
        { candidateRef: 'candidate:a' },
        context(directory).extend(services),
      ),
      /concurrency/,
    );
    assert.equal(
      measurements.length,
      1,
      'invalid private data is rejected before recording',
    );
    await op.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const kind of ['agentbench', 'inferencebench'] as const) {
  for (const outcome of [
    'partial-error',
    'cancelled',
    'missing-snapshot',
    'nonzero-exit',
  ] as const) {
    test(`${kind} preserves ${outcome} evidence, error status and one evaluation charge`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rsi-eval-boundary-'));
      try {
        const { services, measurements, stored } = harness(directory);
        const controller = new AbortController();
        const call = context(directory).extend(services);
        call.signal = controller.signal;
        const charges: [string, number][] = [];
        call.charge = async (resource, amount) => {
          charges.push([resource, amount]);
        };
        call.withInstance = async (candidate, capability, use) => {
          assert.equal(candidate, 'candidate:a');
          assert.equal(
            capability,
            kind === 'agentbench' ? 'agentbundle' : 'inference-endpoint',
          );
          return use(
            kind === 'agentbench'
              ? { directory: '/bundle' }
              : {
                  baseUrl: 'http://endpoint/v1',
                  model: 'served',
                  resources: { verified: true },
                },
          );
        };
        const snap = snapshot(
          kind === 'agentbench' ? 'quality' : 'performance',
        );
        object(snap.run).status =
          outcome === 'cancelled' ? 'cancelled' : 'error';
        const partial =
          outcome === 'missing-snapshot'
            ? { kind: 'ray-jobs', exitCode: 0 }
            : { kind: 'local', exitCode: 1, snapshot: snap };
        const expectedStatus =
          outcome === 'cancelled'
            ? 'cancelled'
            : outcome === 'missing-snapshot'
              ? 'unknown'
              : 'failed';
        const def = evaluatorWithRunner(kind, async (options) => {
          assert.equal(options.signal, controller.signal);
          const native = object(
            JSON.parse(await readFile(options.configPath, 'utf8')),
          );
          assert.equal(
            object(native.benchmark).name,
            kind === 'agentbench' ? 'workbuddy' : 'agentx',
          );
          if (outcome === 'cancelled') controller.abort();
          if (outcome === 'partial-error' || outcome === 'cancelled')
            throw Object.assign(new Error('SDK interrupted'), {
              phase: 'collect',
              result: partial,
            });
          return partial;
        });
        const op = await def.create(
          kind === 'agentbench'
            ? {
                benchmark: 'workbuddy',
                services: {
                  default: { model: 'fixture', base_url: 'http://model' },
                },
              }
            : { benchmark: 'agentx' },
          services,
        );
        await assert.rejects(
          op.execute(
            kind === 'agentbench'
              ? { candidateRef: 'candidate:a', taskIds: ['task/a'] }
              : { candidateRef: 'candidate:a' },
            call,
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              Reflect.get(error, 'measurementRef'),
              'measurement:one',
            );
            assert.equal(Reflect.get(error, 'status'), expectedStatus);
            return true;
          },
        );
        assert.deepEqual(charges, [['evaluationRuns', 1]]);
        assert.equal(measurements.length, 1);
        assert.equal(measurements[0].status, expectedStatus);
        const provenance = object(
          stored.get(object(measurements[0].provenance).artifactRef as string),
        );
        const archived = object(
          stored.get(object(provenance.nativeResult).resultRef as string),
        );
        assert.deepEqual(archived.result, partial);
        if (outcome === 'partial-error' || outcome === 'cancelled') {
          const diagnostic = object(
            stored.get(measurements[0].diagnosticsRef as string),
          );
          assert.equal(diagnostic.phase, 'collect');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  test(`${kind} does not charge or invoke SDK after cancellation or budget rejection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rsi-eval-stop-'));
    try {
      const { services, measurements } = harness(directory);
      let runs = 0;
      let charges = 0;
      const op = await evaluatorWithRunner(kind, async () => {
        runs++;
        return {};
      }).create(
        kind === 'agentbench'
          ? {
              benchmark: 'workbuddy',
              services: {
                default: { model: 'fixture', base_url: 'http://model' },
              },
            }
          : { benchmark: 'agentx' },
        services,
      );
      const call = context(directory).extend(services);
      call.withInstance = async (_candidate, _capability, use) =>
        use(
          kind === 'agentbench'
            ? { directory: '/bundle' }
            : { baseUrl: 'http://endpoint/v1', model: 'served' },
        );
      call.charge = async () => {
        charges++;
        throw new Error('budget exhausted');
      };
      const input: JsonObject =
        kind === 'agentbench'
          ? { candidateRef: 'candidate:a', taskIds: ['task/a'] }
          : { candidateRef: 'candidate:a' };
      call.signal = AbortSignal.abort(new Error('cancelled before run'));
      await assert.rejects(op.execute(input, call), /cancelled before run/);
      assert.equal(charges, 0);
      call.signal = new AbortController().signal;
      await assert.rejects(op.execute(input, call), /budget exhausted/);
      assert.equal(charges, 1);
      assert.equal(runs, 0);
      assert.equal(measurements.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('inferencebench rejects malformed native metrics before storing artifacts or Measurement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-invalid-sdk-metrics-'));
  try {
    for (const metrics of [null, [], { 'success-rate': 0 }]) {
      const { services, stored, measurements } = harness(directory);
      await writeFile(
        join(directory, 'metrics.json'),
        JSON.stringify({ snapshotDigest: 'snapshot', metrics }),
      );
      await assert.rejects(
        normalizeInferencebench(
          {
            services: {
              default: { model: 'fixture', base_url: 'http://model' },
            },
            benchmark: { name: 'agentx', solver: { name: 'agentx-replay' } },
          },
          { candidateRef: 'candidate:a' },
          { resources: { verified: true } },
          {
            kind: 'local',
            exitCode: 0,
            snapshot: snapshot('performance'),
            runDirectory: directory,
          },
          context(directory).extend(services),
        ),
        /object/,
      );
      assert.equal(stored.size, 0);
      assert.equal(measurements.length, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
