import test from 'node:test';
import assert from 'node:assert/strict';
import type { MeasurementSummary } from '../../web/api/observation-client.js';
import { candidateScores } from '../../web/features/experiments/candidate-scores.js';
import {
  primaryMetric,
  primaryScore,
  metricValue,
} from '../../web/features/experiments/measurement-score.js';

function measurement(ref: string, value: number): MeasurementSummary {
  return {
    ref,
    candidateRef: `candidate-${ref}`,
    callId: `call-${ref}`,
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: 'same-workload',
    startedAt: `2026-11-12T00:0${ref === 'baseline' ? 0 : 1}:00Z`,
    finishedAt: null,
    metrics: [
      {
        name: 'inputThroughput',
        definitionRef: 'input',
        unit: 'tokens/sec',
        description: '',
        status: 'unavailable',
        reason: 'Missing input statistic',
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
      {
        name: 'tpotP90',
        definitionRef: 'tpot',
        unit: 'ms',
        description: '',
        status: 'available',
        reason: null,
        values: { value: 52.9 },
      },
    ],
  };
}

test('inference candidate scores include optimization rounds even when only baseline has a validation label', () => {
  const baseline = measurement('baseline', 3523.724);
  const trial = measurement('trial', 6028.1922);
  const { group, scores } = candidateScores(
    [baseline, trial],
    new Set(['baseline']),
  );
  assert.equal(group?.name, 'outputThroughput');
  assert.equal(scores.get('candidate-baseline')?.value, 3523.724);
  assert.equal(scores.get('candidate-trial')?.value, 6028.1922);
  const other = measurement('other', 9999);
  other.comparisonKey = 'another-workload';
  assert.equal(
    candidateScores([baseline, trial, other], new Set()).scores.has(
      'candidate-other',
    ),
    false,
  );
});

test('throughput columns preserve zero and missing or failed metrics never substitute latency', () => {
  const row = measurement('baseline', 0);
  const metric = primaryMetric(row.metrics)!;
  assert.equal(metric.name, 'outputThroughput');
  assert.equal(primaryScore(row), 0);
  assert.equal(
    primaryScore({
      ...row,
      metrics: row.metrics.filter((item) => item.name !== 'outputThroughput'),
    }),
    null,
  );
  assert.equal(
    metricValue(
      {
        ...row,
        metrics: row.metrics.filter((item) => item.name !== 'outputThroughput'),
      },
      metric,
    ),
    null,
  );
  assert.equal(metricValue({ ...row, status: 'failed' }, metric), null);
  assert.equal(
    metricValue(
      { ...row, metrics: [{ ...metric, unit: 'other-unit' }] },
      metric,
    ),
    null,
  );
});
