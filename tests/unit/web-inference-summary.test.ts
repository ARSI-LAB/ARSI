import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  CandidateSummary,
  MeasurementSummary,
} from '../../web/api/observation-client.js';
import {
  inferenceMetric,
  inferenceSummary,
} from '../../web/features/experiments/inference-summary.js';

const candidates: CandidateSummary[] = [
  { ref: 'root', parentRef: null, artifactRef: 'a', originPath: null },
  { ref: 'child', parentRef: 'root', artifactRef: 'b', originPath: null },
];
function measurement(
  ref: string,
  candidateRef: string,
  value: number,
): MeasurementSummary {
  return {
    ref,
    candidateRef,
    callId: `call-${ref}`,
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: 'same-workload',
    startedAt: `2026-11-12T00:0${ref === 'm1' ? 0 : 1}:00Z`,
    finishedAt: null,
    metrics: [
      {
        name: 'inputThroughput',
        definitionRef: 'input',
        unit: 'tokens/sec',
        description: '',
        status: 'unavailable',
        reason: 'Missing',
        values: {},
      },
      {
        name: 'outputThroughput',
        definitionRef: 'output',
        unit: 'tokens/sec',
        description: '',
        status: 'available',
        reason: null,
        values: { value },
      },
    ],
  };
}

test('inference summary selects available output throughput and compares a recorded ancestor', () => {
  const rows = [
    measurement('m1', 'root', 100),
    measurement('m2', 'child', 150),
  ];
  const summary = inferenceSummary(rows, candidates)!;
  assert.equal(summary.best.measurementRef, 'm2');
  assert.equal(summary.baselineValue, 100);
  assert.equal(summary.change, 50);
  assert.equal(summary.points.length, 2);
});

test('inference summary isolates workloads, definitions and incomplete results', () => {
  const base = measurement('m1', 'root', 100);
  const other = measurement('m2', 'child', 900);
  other.comparisonKey = 'other-workload';
  const different = measurement('m3', 'child', 800);
  different.metrics[1]!.definitionRef = 'different-definition';
  const partial = measurement('m4', 'child', 1000);
  partial.coverage = 'partial';
  const failed = measurement('m5', 'child', 2000);
  failed.status = 'failed';
  const rows = [base, other, different, partial, failed];
  const summary = inferenceSummary(rows, candidates)!;
  assert.equal(summary.best.value, 100);
  assert.equal(summary.groups.length, 3);
  const alternate = inferenceSummary(rows, candidates, summary.groups[1]!.key)!;
  assert.equal(alternate.best.value, 900);
  assert.equal(alternate.change, null);
  assert.equal(inferenceMetric(failed, 'outputThroughput'), null);
});

test('missing and ambiguous baselines never produce a percentage', () => {
  const base = measurement('m1', 'root', 100);
  const best = measurement('m2', 'child', 150);
  assert.equal(inferenceSummary([best], candidates)!.change, null);
  const repeat = { ...base, ref: 'repeat' };
  assert.equal(
    inferenceSummary([base, repeat, best], candidates)!.change,
    null,
  );
  base.metrics[1]!.values.value = 0;
  const summary = inferenceSummary([base, best], candidates)!;
  assert.equal(summary.baselineValue, 0);
  assert.equal(summary.change, null);
});

test('unavailable, partial and unknown-condition metrics do not create a report', () => {
  const row = measurement('m1', 'root', 100);
  row.metrics[1]!.status = 'unavailable';
  assert.equal(inferenceSummary([row], candidates), null);
  row.metrics[1]!.status = 'available';
  row.coverage = 'partial';
  assert.equal(inferenceSummary([row], candidates), null);
  row.coverage = 'complete';
  row.comparisonKey = null;
  assert.equal(inferenceSummary([row], candidates), null);
});
