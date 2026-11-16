import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KERNEL_METRIC_CATALOG,
  KERNEL_METRIC_IDS,
  kernelMetricDescriptor,
} from '../../src/plugins/shared/evaluator-adapter/kernel-metrics.js';

test('operator metric catalogue is complete, unique and mapped', () => {
  const ids = KERNEL_METRIC_CATALOG.map((metric) => metric.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'latencyMeanMs',
    'hostMeanMs',
    'endToEndP50Ms',
    'wholeNetP50Ms',
    'launchCount',
    'referenceErrorMaxAbs',
  ])
    assert.ok(KERNEL_METRIC_IDS.includes(id), `missing metric ${id}`);
  for (const metric of KERNEL_METRIC_CATALOG) {
    assert.ok(metric.unit.length > 0);
    assert.ok(metric.mapping.length > 0);
    assert.ok(metric.aggregation.length > 0);
  }
});

test('operator metric descriptors are addressable by id', () => {
  assert.deepEqual(kernelMetricDescriptor('launchCount'), {
    id: 'launchCount',
    unit: 'count',
    mapping: 'kernel-v1 timing.launchCount',
    aggregation: 'launches per forward pass',
  });
  assert.throws(
    () => kernelMetricDescriptor('latencyMs'),
    /Unknown operator kernel metric/,
  );
});
