import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import { inferenceSelectorDefinition } from '../../src/plugins/selector-inference/index.js';
import type { MetricSelectorConfig } from '../../src/plugins/selector-inference/schema.js';
import { readDecisionFeedback } from '../../src/plugins/shared/metric-decision/index.js';
import { digest, json, object } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';
import { measurementFixture } from '../helpers/manager-fixture.js';

async function selectionFixture() {
  const artifacts = new Map<string, JsonValue>();
  const measurements = new Map<string, JsonObject>();
  const context = new RuntimeContext().extend({
    experimentId: 'inference-selection',
    callId: 'evaluate',
    artifacts: {
      async putJson(value) {
        json(value);
        const ref = `artifact:${digest(value)}`;
        artifacts.set(ref, value);
        return ref;
      },
      async readJson(ref) {
        const value = artifacts.get(ref);
        assert.notEqual(value, undefined);
        return value!;
      },
      async capture() {
        throw new Error('unused');
      },
      async materialize() {},
    },
    async readMeasurement(ref) {
      const measurement = measurements.get(ref);
      assert.ok(measurement);
      return measurement;
    },
  });
  const base = await measurementFixture(context);
  async function measured(
    ref: string,
    values: Record<string, number | null>,
    overrides: JsonObject = {},
  ): Promise<void> {
    const metrics: JsonObject = {};
    for (const [id, value] of Object.entries(values)) {
      const definitionRef = await context.artifacts.putJson({
        id,
        description: id,
        unit: id === 'throughput' ? 'requests/s' : 'scalar',
        valueKind: 'scalar',
        version: 1,
        aggregation: 'single point',
        mapping: id,
      });
      metrics[id] = {
        definitionRef,
        status: value === null ? 'unavailable' : 'available',
        value: value === null ? null : { kind: 'scalar', value },
        ...(value === null ? { reason: 'Performance unavailable' } : {}),
        source: {
          artifactRef: object(base.conditions).artifactRef,
          pointer: '',
        },
      };
    }
    measurements.set(ref, {
      ...base,
      ref,
      candidateRef: `candidate-${ref}`,
      comparisonKey: 'fixed-workload',
      metrics,
      ...overrides,
    });
  }
  async function select(config: MetricSelectorConfig = {}) {
    const selector = await inferenceSelectorDefinition.create(
      {
        metric: 'throughput',
        direction: 'maximize',
        constraints: [{ metric: 'ttft', max: 100 }],
        ...config,
      },
      context,
    );
    try {
      const output = await selector.execute(
        {
          incumbentMeasurementRef: 'before',
          candidateMeasurementRef: 'after',
        },
        context,
      );
      validate(inferenceSelectorDefinition.contract.output_schema, output);
      return output;
    } finally {
      await selector.dispose();
    }
  }
  return { measured, select, context };
}

test('inference selection accepts 120 to 105 progress toward a 100 limit and records truthful feasibility', async () => {
  const fixture = await selectionFixture();
  await fixture.measured('before', { throughput: 100, ttft: 120 });
  await fixture.measured('after', { throughput: 90, ttft: 105 });
  const result = await fixture.select();
  assert.equal(result.accepted, true);
  assert.equal(result.candidateFeasible, false);
  assert.equal(result.selectedCandidateRef, 'candidate-after');
  assert.equal(result.measurementRef, 'after');
  assert.equal(result.selectedValue, 90);
  assert.match(result.reason, /reduces constraint violations/);
  const decision = object(
    await fixture.context.artifacts.readJson(result.decisionRef),
  );
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.measurementRefs, ['before', 'after']);
  assert.ok(Array.isArray(decision.constraints));
  assert.equal(object(decision.constraints[0]).passed, false);
  const feedback = await readDecisionFeedback(
    'after',
    result.decisionRef,
    'candidate-after',
    fixture.context,
  );
  assert.deepEqual(feedback.constraints, [5]);
  assert.equal(feedback.loss, -90);
});

test('inference selection never trades a worse constraint violation for another improvement', async () => {
  const fixture = await selectionFixture();
  await fixture.measured('before', {
    throughput: 100,
    ttft: 120,
    capacity: 10,
  });
  for (const [ttft, capacity, accepted] of [
    [105, 15, true],
    [105, 9, false],
    [125, 20, false],
  ] as const) {
    await fixture.measured('after', { throughput: 200, ttft, capacity });
    const result = await fixture.select({
      constraints: [
        { metric: 'ttft', max: 100 },
        { metric: 'capacity', min: 20 },
      ],
    });
    assert.equal(result.accepted, accepted);
    assert.equal(result.candidateFeasible, false);
  }
});

test('inference selection prioritizes attaining and preserving feasibility', async () => {
  const fixture = await selectionFixture();
  await fixture.measured('before', { throughput: 100, ttft: 105 });
  await fixture.measured('after', { throughput: 50, ttft: 100 });
  const attained = await fixture.select({ minRelativeImprovement: 0.1 });
  assert.equal(attained.accepted, true);
  assert.equal(attained.candidateFeasible, true);
  await fixture.measured('before', { throughput: 50, ttft: 100 });
  await fixture.measured('after', { throughput: 200, ttft: 101 });
  const regressed = await fixture.select();
  assert.equal(regressed.accepted, false);
  assert.equal(regressed.candidateFeasible, false);
  assert.equal(regressed.selectedCandidateRef, 'candidate-before');
});

test('equal feasibility uses the strict objective improvement threshold in either direction', async () => {
  const fixture = await selectionFixture();
  for (const ttft of [90, 105]) {
    await fixture.measured('before', { throughput: 100, ttft });
    for (const [direction, value, accepted] of [
      ['maximize', 100, false],
      ['maximize', 110, false],
      ['maximize', 111, true],
      ['minimize', 90, false],
      ['minimize', 89, true],
    ] as const) {
      await fixture.measured('after', { throughput: value, ttft });
      const result = await fixture.select({
        direction,
        minRelativeImprovement: 0.1,
      });
      assert.equal(result.accepted, accepted);
      assert.equal(result.candidateFeasible, ttft <= 100);
    }
  }
});

test('inference selection keeps eligibility hard and rejects incomparable measurements', async () => {
  const fixture = await selectionFixture();
  await fixture.measured('before', { throughput: 100, ttft: 120, valid: 1 });
  await fixture.measured(
    'after',
    { throughput: null, valid: 0 },
    { coverage: 'partial', comparisonKey: null },
  );
  const rejected = await fixture.select({
    eligibility: [{ metric: 'valid', min: 1 }],
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.candidateFeasible, false);
  assert.equal(rejected.candidateValue, null);
  assert.match(rejected.reason, /eligibility/);
  await fixture.measured(
    'after',
    { throughput: 110, ttft: 105 },
    { comparisonKey: 'different-workload' },
  );
  await assert.rejects(fixture.select(), /not complete and comparable/);
  await fixture.measured('after', { throughput: 110, ttft: 105 });
  await assert.rejects(
    fixture.select({ constraints: [{ metric: 'ttft', min: 101, max: 100 }] }),
    /min exceeds max/,
  );
});

test('configurable strict bounds and cleaned failed candidates', async () => {
  const f = await selectionFixture();
  const config = {
    constraints: [{ metric: 'ttft', max: 100, exclusiveMax: true }],
  };
  await f.measured('before', { throughput: 100, ttft: 99 });
  await f.measured('after', { throughput: 200, ttft: 100 });
  assert.equal((await f.select(config)).accepted, false);
  await f.measured('before', { throughput: 100, ttft: 120 });
  await f.measured('after', { throughput: 200, ttft: 119.99 });
  assert.equal((await f.select(config)).accepted, true);
  await f.measured('after', { throughput: 90, ttft: 110 });
  assert.equal((await f.select(config)).accepted, true);
  await f.measured(
    'after',
    {},
    { status: 'failed', coverage: 'none', comparisonKey: null },
  );
  const rejected = await f.select(config);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.candidateValue, null);
});
