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
