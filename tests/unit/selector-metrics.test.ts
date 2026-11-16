import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';
import type { MetricSelectorConfig } from '../../src/plugins/selector-metrics/schema.js';
import {
  validateMeasurement,
  typedArtifact,
  recordSchema,
  measurementItemsSchema,
} from '../../src/contracts/models/measurement.js';
import { digest, object } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';
import { readDecisionFeedback } from '../../src/plugins/shared/metric-decision/index.js';

async function selectionFixture() {
  const content = new Map<string, JsonValue>();
  const measurements = new Map<string, JsonObject>();
  const put = async (value: unknown): Promise<string> => {
    const artifact = object(value);
    const ref = `artifact:${digest(artifact)}`;
    content.set(ref, artifact);
    return ref;
  };
  const definition = async (id: string, valueKind = 'scalar') =>
    put({
      id,
      description: id,
      unit: id === 'latencyMs' ? 'ms' : 'ratio',
      valueKind,
      version: 1,
      aggregation: 'fixed task',
      mapping: id,
    });
  const validityRef = await definition('candidateValid');
  const latencyRef = await definition('latencyMs', 'distribution');
  const metadata = typedArtifact(
    'test.metadata/v1',
    recordSchema({ name: { type: 'string' } }),
    await put({ name: 'fixed task' }),
  );
  const source = { artifactRef: metadata.artifactRef, pointer: '' };
  const validity = (value: number | null): JsonObject =>
    value === null
      ? {
          definitionRef: validityRef,
          status: 'unavailable',
          value: null,
          reason: 'Assessment unavailable',
          source,
        }
      : {
          definitionRef: validityRef,
          status: 'available',
          value: { kind: 'scalar', value },
          source,
        };
  const latency = (value: number | null): JsonObject =>
    value === null
      ? {
          definitionRef: latencyRef,
          status: 'unavailable',
          value: null,
          reason: 'Candidate did not reach performance assessment',
          source,
        }
      : {
          definitionRef: latencyRef,
          status: 'available',
          value: {
            kind: 'distribution',
            count: 3,
            mean: value,
            p50: value,
            p95: value,
            p99: value,
          },
          source,
        };
  const itemsRef = await put({
    schemaVersion: 'rsi.measurement-items/v1',
    items: [],
  });
  function measured(
    ref: string,
    value: number | null | undefined,
    valid: number | null = 1,
    overrides: JsonObject = {},
  ): JsonObject {
    const measurement: JsonObject = {
      schemaVersion: 'rsi.measurement/v1',
      ref,
      experimentId: 'experiment',
      callId: `evaluate-${ref}`,
      candidateRef: `candidate-${ref}`,
      evaluator: { pluginId: 'test.evaluator', implementationDigest: 'fixed' },
      startedAt: '2026-10-28T00:00:00.000Z',
      finishedAt: '2026-10-28T00:00:01.000Z',
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'fixed-task',
      conditions: metadata,
      provenance: metadata,
      metrics: {
        candidateValid: validity(valid),
        ...(value === undefined ? {} : { latencyMs: latency(value) }),
      },
      itemsRef,
      evidenceIndexRef: metadata.artifactRef,
      profile: metadata,
      diagnosticsRef: null,
      extensions: [],
      ...overrides,
    };
    validateMeasurement(measurement);
    measurements.set(ref, measurement);
    return measurement;
  }
  measured('before', 10);
  measured('after', 8);
  const services = new RuntimeContext().extend({
    experimentId: 'experiment',
    artifacts: {
      putJson: put,
      readJson: async (ref: string) => {
        const artifact = content.get(ref);
        assert.ok(artifact);
        return artifact;
      },
      capture: async () => {
        throw new Error('unused');
      },
      materialize: async () => {},
    },
    readMeasurement: async (ref: string) => {
      const measurement = measurements.get(ref);
      assert.ok(measurement);
      return measurement;
    },
  });
  const input = {
    incumbentMeasurementRef: 'before',
    candidateMeasurementRef: 'after',
  };
  async function select(config: JsonObject = {}) {
    const selector = await metricSelectorDefinition.create(
      {
        metric: 'latencyMs',
        direction: 'minimize',
        statistic: 'p50',
        ...config,
      },
      services,
    );
    try {
      const result = await selector.execute(input, services);
      validate(metricSelectorDefinition.contract.output_schema, result);
      return result;
    } finally {
      await selector.dispose();
    }
  }
  return {
    measured,
    services,
    select,
    put,
    validity,
    latency,
    metadata,
    read: services.artifacts.readJson,
  };
}

const correctness = {
  constraints: [{ metric: 'candidateValid', prerequisite: true, min: 1 }],
};

test('metric prerequisites reject assessed invalid candidates before requiring performance data', async () => {
  const fixture = await selectionFixture();
  for (const value of [null, undefined]) {
    fixture.measured('after', value, 0, {
      coverage: 'partial',
      comparisonKey: null,
    });
    const result = await fixture.select({
      constraints: [
        { metric: 'unavailablePerformance', max: 10 },
        ...correctness.constraints,
      ],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.candidateFeasible, false);
    assert.equal(result.candidateValue, null);
    assert.equal(result.incumbentValue, 10);
    assert.equal(result.selectedValue, 10);
    assert.equal(result.selectedCandidateRef, 'candidate-before');
    assert.equal(result.measurementRef, 'before');
    assert.match(result.reason, /prerequisite/i);
    const decision = object(await fixture.read(result.decisionRef));
    assert.equal(decision.candidateValue, null);
    assert.equal(decision.incumbentValue, 10);
    assert.deepEqual(decision.measurementRefs, ['before', 'after']);
    assert.equal(decision.definitionRef, fixture.latency(10).definitionRef);
    assert.ok(Array.isArray(decision.constraints));
    assert.equal(decision.constraints.length, 1);
    assert.equal(object(decision.constraints[0]).prerequisite, true);
    assert.equal(
      object(decision.constraints[0]).definitionRef,
      fixture.validity(0).definitionRef,
    );
  }
});

test('metric prerequisites preserve scoped assessment status and all prerequisite checks', async () => {
  const fixture = await selectionFixture();
  async function pointMeasurement(
    ref: string,
    valid: number,
    overrides: JsonObject = {},
  ): Promise<void> {
    const point = {
      id: 'case-1',
      subject: {
        kind: 'operator-case',
        id: 'case-1',
        parameters: fixture.metadata,
      },
      status: 'succeeded',
      coverage: valid === 1 ? 'complete' : 'partial',
      comparisonKey: valid === 1 ? 'case-1-fixed' : null,
      metrics: {
        candidateValid: fixture.validity(valid),
        ...(valid === 1 ? { latencyMs: fixture.latency(10) } : {}),
      },
      evaluation: null,
      evidenceIndexRef: fixture.metadata.artifactRef,
      details: fixture.metadata,
      ...overrides,
    };
    fixture.measured(ref, undefined, valid, {
      coverage: valid === 1 ? 'complete' : 'partial',
      comparisonKey: valid === 1 ? 'task-fixed' : null,
      metrics: {},
      itemsRef: await fixture.put({
        schemaVersion: 'rsi.measurement-items/v1',
        items: [point],
      }),
    });
  }
  await pointMeasurement('before', 1);
  await pointMeasurement('after', 0);
  const config = { ...correctness, itemId: 'case-1' };
  assert.equal((await fixture.select(config)).candidateValue, null);
  await pointMeasurement('after', 0, { status: 'unknown' });
  await assert.rejects(fixture.select(config), /succeeded.*assessment/i);
  await pointMeasurement('after', 0, {
    subject: {
      kind: 'different-case',
      id: 'case-1',
      parameters: fixture.metadata,
    },
  });
  await assert.rejects(fixture.select(config), /subject kinds differ/i);
  await pointMeasurement('after', 0);
  await assert.rejects(
    fixture.select({
      ...config,
      constraints: [
        { metric: 'candidateValid', prerequisite: true, min: 1 },
        { metric: 'missingPrerequisite', prerequisite: true, max: 0 },
      ],
    }),
    /missingPrerequisite.*unavailable/i,
  );
});

test('metric prerequisites require owned, completed assessments and compatible prerequisite definitions', async () => {
  const fixture = await selectionFixture();
  const cases: {
    overrides: JsonObject;
    valid?: number | null;
    error: RegExp;
  }[] = [
    { overrides: { experimentId: 'other' }, valid: 0, error: /ownership/i },
    { overrides: { ref: 'other' }, valid: 0, error: /identity/i },
    {
      overrides: { status: 'unknown' },
      valid: 0,
      error: /complete|succeeded/i,
    },
    { overrides: { status: 'failed' }, valid: 0, error: /complete|succeeded/i },
    {
      overrides: { status: 'cancelled' },
      valid: 0,
      error: /complete|succeeded/i,
    },
    { overrides: { finishedAt: null }, valid: 0, error: /complete|finished/i },
    { overrides: {}, valid: null, error: /definition|unavailable/i },
    { overrides: { metrics: {} }, error: /candidateValid.*unavailable/i },
    {
      overrides: { metrics: { candidateValid: { status: 'available' } } },
      error: /Measurement/,
    },
    {
      overrides: {
        metrics: {
          candidateValid: {
            ...fixture.validity(0),
            definitionRef: await fixture.put({
              id: 'candidateValid',
              description: 'different validity rule',
              unit: 'ratio',
              valueKind: 'scalar',
              version: 1,
              aggregation: 'different task',
              mapping: 'different source',
            }),
          },
        },
      },
      error: /definition/i,
    },
  ];
  for (const entry of cases) {
    const measurement = fixture.measured('after', null, entry.valid);
    Object.assign(measurement, entry.overrides);
    await assert.rejects(fixture.select(correctness), entry.error);
  }
});

test('metric prerequisites require a valid incumbent and fully comparable eligible performance', async () => {
  const fixture = await selectionFixture();
  fixture.measured('before', null, 0);
  fixture.measured('after', null, 0);
  await assert.rejects(fixture.select(correctness), /incumbent.*prerequisite/i);
  fixture.measured('before', 10, 1, { coverage: 'partial' });
  await assert.rejects(fixture.select(correctness), /complete.*comparable/i);
  fixture.measured('before', null);
  await assert.rejects(fixture.select(correctness), /definition|unavailable/i);
  fixture.measured('before', 10);
  fixture.measured('after', null);
  await assert.rejects(fixture.select(correctness), /definition|unavailable/i);
  fixture.measured('after', undefined);
  await assert.rejects(fixture.select(correctness), /latencyMs.*unavailable/i);
  fixture.measured('after', 8, 1, {
    metrics: {
      candidateValid: fixture.validity(1),
      latencyMs: {
        ...fixture.latency(8),
        definitionRef: fixture.validity(1).definitionRef,
      },
    },
  });
  await assert.rejects(fixture.select(correctness), /definition/i);
  fixture.measured('after', 8, 1, { comparisonKey: null });
  await assert.rejects(fixture.select(correctness), /comparable/i);
  fixture.measured('after', 8, 1, { coverage: 'partial' });
  await assert.rejects(fixture.select(correctness), /complete.*comparable/i);
});

test('metric selector requires improvement strictly beyond the configured relative threshold', async () => {
  const fixture = await selectionFixture();
  const scenarios = [
    {
      direction: 'minimize',
      before: 10,
      after: 9.9,
      threshold: 0.02,
      accepted: false,
    },
    {
      direction: 'minimize',
      before: 10,
      after: 8,
      threshold: 0.02,
      accepted: true,
    },
    {
      direction: 'minimize',
      before: 10,
      after: 8,
      threshold: 0.2,
      accepted: false,
    },
    {
      direction: 'minimize',
      before: 10,
      after: 10,
      threshold: 0.02,
      accepted: false,
    },
    {
      direction: 'maximize',
      before: 10,
      after: 12,
      threshold: 0.1,
      accepted: true,
    },
    {
      direction: 'maximize',
      before: 10,
      after: 12,
      threshold: 0.2,
      accepted: false,
    },
    {
      direction: 'maximize',
      before: 1,
      after: 1.1,
      threshold: 0.1,
      accepted: false,
    },
    {
      direction: 'minimize',
      before: 1,
      after: 0.7,
      threshold: 0.3,
      accepted: false,
    },
    {
      direction: 'maximize',
      before: 10,
      after: 9,
      threshold: 0.02,
      accepted: false,
    },
  ];
  for (const scenario of scenarios) {
    fixture.measured('before', scenario.before);
    fixture.measured('after', scenario.after);
    const result = await fixture.select({
      direction: scenario.direction,
      minRelativeImprovement: scenario.threshold,
    });
    assert.equal(result.accepted, scenario.accepted, JSON.stringify(scenario));
    assert.equal(result.candidateFeasible, true);
    assert.equal(result.candidateValue, scenario.after);
    assert.equal(
      result.selectedValue,
      scenario.accepted ? scenario.after : scenario.before,
    );
  }
});

test('relative thresholds reject unsupported config and nonpositive incumbents while zero preserves strict comparison', async () => {
  const fixture = await selectionFixture();
  for (const threshold of [-0.01, 1, '0.02'])
    await assert.rejects(
      fixture.select({ minRelativeImprovement: threshold }),
      /metric selector config/,
    );
  await assert.rejects(
    fixture.select({
      constraints: [{ metric: 'candidateValid', prerequisite: true }],
    }),
    /metric selector config/,
  );
  await assert.rejects(
    fixture.select({
      constraints: [
        { metric: 'candidateValid', prerequisite: true, min: 1, max: 0 },
      ],
    }),
    /min exceeds max/,
  );
  for (const before of [0, -1]) {
    fixture.measured('before', before);
    fixture.measured('after', before - 1);
    await assert.rejects(
      fixture.select({ minRelativeImprovement: 0.02 }),
      /positive.*incumbent|incumbent.*positive/i,
    );
    assert.equal((await fixture.select()).accepted, true);
    assert.equal(
      (await fixture.select({ minRelativeImprovement: 0 })).accepted,
      true,
    );
    fixture.measured('after', before + 1);
    assert.equal(
      (await fixture.select({ direction: 'maximize' })).accepted,
      true,
    );
  }
});

test('metric selector compares only the requested AgentX point, checks definitions and constraints, and retains ties', async () => {
  const content = new Map<string, JsonValue>();
  const measurements = new Map<string, JsonObject>();
  const put = async (value: unknown): Promise<string> => {
    const v = object(value);
    const ref = `artifact:${digest(v)}`;
    content.set(ref, v);
    return ref;
  };
  const metricDefinition = async (id: string, unit: string) =>
    put({
      id,
      description: id,
      unit,
      valueKind: 'distribution',
      version: 1,
      aggregation: 'single native workload point',
      mapping: `profiling.${id}`,
    });
  const throughput = await metricDefinition('outputThroughput', 'tokens/sec');
  const latency = await metricDefinition('requestLatency', 'ms');
  const metaSchema = recordSchema({ name: { type: 'string' } });
  const metadata = typedArtifact(
    'test.metadata/v1',
    metaSchema,
    await put({ name: 'fixed identity' }),
  );
  const observation = (ref: string, mean: number, p95: number): JsonObject => ({
    definitionRef: ref,
    status: 'available',
    value: { kind: 'distribution', count: 10, mean, p50: mean, p95, p99: p95 },
    source: { artifactRef: metadata.artifactRef, pointer: '/profiling' },
  });
  async function measured(
    ref: string,
    candidateRef: string,
    rate: number,
    delay: number,
    definition = throughput,
  ): Promise<JsonObject> {
    const point = {
      id: 'agentx-256k-replay-c4',
      subject: {
        kind: 'workload-point',
        id: 'agentx-256k-replay-c4',
        parameters: metadata,
      },
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'fixed-c4',
      evaluation: null,
      metrics: {
        outputThroughput: observation(definition, rate, rate),
        requestLatency: observation(latency, delay, delay),
      },
      evidenceIndexRef: metadata.artifactRef,
      details: metadata,
    };
    const list = {
      schemaVersion: 'rsi.measurement-items/v1',
      items: [
        point,
        {
          ...point,
          id: 'agentx-256k-replay-c1',
          subject: { ...point.subject, id: 'agentx-256k-replay-c1' },
          comparisonKey: 'fixed-c1',
          metrics: { outputThroughput: observation(throughput, 99999, 99999) },
        },
      ],
    };
    validate(measurementItemsSchema, list);
    const value: JsonObject = {
      schemaVersion: 'rsi.measurement/v1',
      ref,
      experimentId: 'experiment',
      callId: ref,
      candidateRef,
      evaluator: {
        pluginId: 'evaluator.inferencebench',
        implementationDigest: 'fixed-code',
      },
      startedAt: '2026-10-25T00:00:00.000Z',
      finishedAt: '2026-10-25T00:00:01.000Z',
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'fixed-run',
      conditions: metadata,
      provenance: metadata,
      metrics: {},
      itemsRef: await put(list),
      evidenceIndexRef: metadata.artifactRef,
      profile: metadata,
      diagnosticsRef: null,
      extensions: [],
    };
    validateMeasurement(value);
    measurements.set(ref, value);
    return value;
  }
  await measured('before', 'candidate-before', 100, 50);
  await measured('after', 'candidate-after', 200, 60);
  const services: RuntimeContext = new RuntimeContext().extend({
    rootDirectory: '.',
    dataDirectory: '.',
    artifacts: {
      putJson: put,
      readJson: async (ref) => {
        const v = content.get(ref);
        assert.ok(v);
        return v;
      },
      capture: async () => {
        throw new Error('unused');
      },
      materialize: async () => {},
    },
    facts: {
      read: async () => ({}),
      write: async () => {},
      list: async () => [],
    },
    workspaces: {
      create: async () => ({
        ref: 'unused',
        directory: '.',
        parentCandidateRef: null,
      }),
      read: async () => ({
        ref: 'unused',
        directory: '.',
        parentCandidateRef: null,
      }),
      release: async () => {},
    },
    readCandidate: async () => {
      throw new Error('unused');
    },
    recordCandidate: async () => {
      throw new Error('unused');
    },
    recordMeasurement: async () => {
      throw new Error('unused');
    },
    readMeasurement: async (ref) => {
      const v = measurements.get(ref);
      assert.ok(v);
      return v;
    },
    application: async () => ({}),
    applicationMetadata: async () => ({}),
    invokeAgent: async () => ({}),
    readEvidence: async () => [],
    invoke: async () => ({}),
    charge: async () => {},
    withInstance: async () => {
      throw new Error('unused');
    },
  });
  const context: RuntimeContext = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'select',
    bindingId: 'selector',
    idempotencyKey: 'select',
    directory: '.',
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
  });
  const config = {
    metric: 'outputThroughput',
    direction: 'maximize',
    itemId: 'agentx-256k-replay-c4',
    statistic: 'mean',
  } satisfies MetricSelectorConfig;
  const input = {
    incumbentMeasurementRef: 'before',
    candidateMeasurementRef: 'after',
  };
  const defaultConfig = {};
  const defaultSelector = await metricSelectorDefinition.create(
    defaultConfig,
    services,
  );
  assert.deepEqual(defaultConfig, {});
  await assert.rejects(
    defaultSelector.execute(input, context.extend(services)),
    /Metric successRate is unavailable/,
  );
  await defaultSelector.dispose();
  const definition: OperationDefinition = metricSelectorDefinition;
  const invalidConfigs: JsonObject[] = [
    { direction: 'sideways' },
    { statistic: 'average' },
    { tieBreak: 'replace' },
    { constraints: [{ metric: 'requestLatency' }] },
  ];
  for (const invalid of invalidConfigs) {
    await assert.rejects(
      definition.create(invalid, services),
      /metric selector config/,
    );
  }
  await assert.rejects(
    metricSelectorDefinition.create(
      { constraints: [{ metric: 'requestLatency', min: 10, max: 5 }] },
      services,
    ),
    /min exceeds max/,
  );
  const selector = await metricSelectorDefinition.create(config, services);
  const acceptance = object(
    await selector.execute(input, context.extend(services)),
  );
  validate(metricSelectorDefinition.contract.output_schema, acceptance);
  assert.equal(acceptance.accepted, true);
  assert.equal(acceptance.candidateFeasible, true);
  assert.equal(acceptance.metric, 'outputThroughput');
  assert.equal(acceptance.incumbentValue, 100);
  assert.equal(acceptance.candidateValue, 200);
  assert.equal(acceptance.selectedValue, 200);
  const constrained = await metricSelectorDefinition.create(
    {
      ...config,
      constraints: [{ metric: 'requestLatency', statistic: 'p95', max: 55 }],
    },
    services,
  );
  const rejection = object(
    await constrained.execute(input, context.extend(services)),
  );
  assert.equal(rejection.accepted, false);
  assert.equal(rejection.candidateFeasible, false);
  assert.equal(rejection.selectedCandidateRef, 'candidate-before');
  assert.equal(rejection.candidateValue, 200);
  assert.equal(rejection.selectedValue, 100);
  assert.match(String(rejection.reason), /constraint/i);
  await measured('after', 'candidate-after', 100, 50);
  const tie = object(await selector.execute(input, context.extend(services)));
  assert.equal(tie.accepted, false);
  assert.equal(tie.selectedValue, 100);
  const baseline = object(
    await selector.execute(
      { incumbentMeasurementRef: 'before', candidateMeasurementRef: 'before' },
      context.extend(services),
    ),
  );
  assert.equal(baseline.accepted, false);
  assert.equal(baseline.candidateFeasible, true);
  assert.equal(baseline.incumbentValue, 100);
  assert.equal(baseline.selectedValue, 100);
  await measured(
    'after',
    'candidate-after',
    200,
    50,
    await metricDefinition('outputThroughput', 'tokens/ms'),
  );
  await assert.rejects(
    selector.execute(input, context.extend(services)),
    /definition/i,
  );
  const unknown = await measured('after', 'candidate-after', 200, 50);
  unknown.comparisonKey = null;
  await assert.rejects(
    selector.execute(input, context.extend(services)),
    /comparable/i,
  );
});

test('metric decision feedback validates prerequisites alongside performance constraints', async () => {
  const fixture = await selectionFixture();
  const result = await fixture.select({
    constraints: [
      { metric: 'latencyMs', statistic: 'p50', max: 7 },
      ...correctness.constraints,
    ],
    minRelativeImprovement: 0.02,
  });
  assert.equal(result.candidateFeasible, false);
  assert.equal(result.candidateValue, 8);
  const feedback = await readDecisionFeedback(
    'after',
    result.decisionRef,
    'candidate-after',
    fixture.services,
  );
  assert.equal(feedback.loss, 8);
  assert.deepEqual(feedback.constraints, [0, 1]);
  assert.deepEqual(feedback.identity.constraints, [
    {
      metric: 'candidateValid',
      statistic: null,
      prerequisite: true,
      definitionRef: fixture.validity(1).definitionRef,
      min: 1,
      max: null,
    },
    {
      metric: 'latencyMs',
      statistic: 'p50',
      prerequisite: false,
      definitionRef: fixture.latency(8).definitionRef,
      min: null,
      max: 7,
    },
  ]);
  fixture.measured('after', 8, 0);
  await assert.rejects(
    readDecisionFeedback(
      'after',
      result.decisionRef,
      'candidate-after',
      fixture.services,
    ),
    /constraint does not match measurement/,
  );
});

test('metric decision feedback rejects an ineligible candidate without an objective', async () => {
  const fixture = await selectionFixture();
  fixture.measured('after', null, 0);
  const result = await fixture.select(correctness);
  await assert.rejects(
    readDecisionFeedback(
      'after',
      result.decisionRef,
      'candidate-after',
      fixture.services,
    ),
    /requires an available objective/,
  );
});

test('relative constraints bound the candidate against its incumbent', async () => {
  const fixture = await selectionFixture();
  const guard = {
    guards: [
      { metric: 'latencyMs', statistic: 'p50', maxRelativeToIncumbent: 0.9 },
    ],
  };
  const passing = await fixture.select(guard);
  assert.equal(passing.accepted, true);
  assert.equal(passing.candidateFeasible, true);
  const passingDecision = object(await fixture.read(passing.decisionRef));
  assert.ok(Array.isArray(passingDecision.guards));
  assert.equal(object(passingDecision.guards[0]).maxRelativeToIncumbent, 0.9);
  fixture.measured('after', 9.5);
  const failing = await fixture.select(guard);
  assert.equal(failing.accepted, false);
  assert.equal(failing.candidateFeasible, false);
  assert.match(String(failing.reason), /guard.*latencyMs/i);
  const failingDecision = object(await fixture.read(failing.decisionRef));
  assert.ok(Array.isArray(failingDecision.guards));
  assert.equal(object(failingDecision.guards[0]).passed, false);
  fixture.measured('after', 8.6);
  const lower = await fixture.select({
    constraints: [
      { metric: 'latencyMs', statistic: 'p50', minRelativeToIncumbent: 0.85 },
    ],
  });
  assert.equal(lower.accepted, true);
  assert.equal(lower.candidateFeasible, true);
  fixture.measured('after', 8.4);
  assert.equal(
    (
      await fixture.select({
        constraints: [
          {
            metric: 'latencyMs',
            statistic: 'p50',
            minRelativeToIncumbent: 0.85,
          },
        ],
      })
    ).candidateFeasible,
    false,
  );
});

test('relative constraints reject unsupported configs and nonpositive incumbents', async () => {
  const fixture = await selectionFixture();
  for (const value of [0, -1, '0.9'])
    await assert.rejects(
      fixture.select({
        constraints: [
          {
            metric: 'latencyMs',
            statistic: 'p50',
            maxRelativeToIncumbent: value,
          },
        ],
      }),
      /metric selector config/,
    );
  await assert.rejects(
    fixture.select({
      constraints: [
        {
          metric: 'latencyMs',
          statistic: 'p50',
          minRelativeToIncumbent: 0.95,
          maxRelativeToIncumbent: 0.9,
        },
      ],
    }),
    /relative min exceeds max/,
  );
  for (const before of [0, -1]) {
    fixture.measured('before', before);
    fixture.measured('after', before - 1);
    await assert.rejects(
      fixture.select({
        guards: [
          {
            metric: 'latencyMs',
            statistic: 'p50',
            maxRelativeToIncumbent: 0.9,
          },
        ],
      }),
      /positive incumbent/i,
    );
  }
});

test('guards are hard constraints that override an improving candidate', async () => {
  const fixture = await selectionFixture();
  fixture.measured('after', 9.8);
  const result = await fixture.select({
    guards: [
      { metric: 'latencyMs', statistic: 'p95', maxRelativeToIncumbent: 0.95 },
    ],
  });
  assert.equal(result.accepted, false);
  assert.equal(result.candidateFeasible, false);
  assert.equal(result.candidateValue, 9.8);
  assert.match(String(result.reason), /guard/i);
  const decision = object(await fixture.read(result.decisionRef));
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.guards, [
    {
      metric: 'latencyMs',
      prerequisite: false,
      statistic: 'p95',
      definitionRef: fixture.latency(9.8).definitionRef,
      min: null,
      max: null,
      minRelativeToIncumbent: null,
      maxRelativeToIncumbent: 0.95,
      exclusiveMax: false,
      incumbentValue: 10,
      candidateValue: 9.8,
      passed: false,
    },
  ]);
  const feedback = await readDecisionFeedback(
    'after',
    result.decisionRef,
    'candidate-after',
    fixture.services,
  );
  assert.equal(feedback.constraints.length, 1);
  assert.ok(Math.abs(feedback.constraints[0]! - 0.3) < 1e-12);
});

test('noise raises the effective threshold from the incumbent distribution', async () => {
  const fixture = await selectionFixture();
  const distribution = (value: number, p95: number, count = 5) => ({
    metrics: {
      candidateValid: fixture.validity(1),
      latencyMs: {
        ...fixture.latency(value),
        value: {
          kind: 'distribution',
          count,
          mean: value,
          p50: value,
          p95,
          p99: p95,
        },
      },
    },
  });
  fixture.measured('before', 10, 1, distribution(10, 12));
  fixture.measured('after', 9.5);
  const noise = {
    minSamples: 3,
    statistic: 'p50',
    confidenceZ: 1.96,
    minRelativeImprovementFloor: 0,
  };
  const result = await fixture.select({ minRelativeImprovement: 0.02, noise });
  const expected = (1.96 * (2 / 1.6448536269514722)) / Math.sqrt(5) / 10;
  assert.equal(result.accepted, false);
  assert.equal(result.candidateFeasible, true);
  assert.match(String(result.reason), /relative improvement threshold/i);
  const decision = object(await fixture.read(result.decisionRef));
  assert.ok(
    Math.abs(Number(decision.effectiveMinRelativeImprovement) - expected) <
      1e-12,
  );
  const measuredNoise = object(decision.noise);
  assert.ok(
    Math.abs(Number(measuredNoise.relativeHalfWidth) - expected) < 1e-12,
  );
  assert.equal(measuredNoise.samples, 5);
  fixture.measured('after', 8.9);
  assert.equal(
    (await fixture.select({ minRelativeImprovement: 0.02, noise })).accepted,
    true,
  );
  fixture.measured('after', 9.5);
  fixture.measured('before', 10, 1, distribution(10, 10));
  const floor = await fixture.select({
    minRelativeImprovement: 0.02,
    noise: { ...noise, minRelativeImprovementFloor: 0.08 },
  });
  assert.equal(floor.accepted, false);
  const floorDecision = object(await fixture.read(floor.decisionRef));
  assert.equal(floorDecision.effectiveMinRelativeImprovement, 0.08);
  fixture.measured('before', 10, 1, distribution(10, 12, 2));
  const sparse = await fixture.select({ minRelativeImprovement: 0.02, noise });
  assert.equal(sparse.accepted, true);
  const sparseDecision = object(await fixture.read(sparse.decisionRef));
  assert.equal(sparseDecision.effectiveMinRelativeImprovement, 0.02);
  assert.equal(object(sparseDecision.noise).samples, null);
  assert.equal(object(sparseDecision.noise).relativeHalfWidth, null);
});
