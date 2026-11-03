import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  CandidateSummary,
  MeasurementSummary,
  MetricObservation,
} from '../../web/api/observation-client.js';
import {
  comparableBaseline,
  recordedDuration,
  rootCandidate,
} from '../../web/features/experiments/experiment-summary.js';
const candidates: CandidateSummary[] = [
  { ref: 'root', parentRef: null, artifactRef: 'a' },
  { ref: 'final', parentRef: 'root', artifactRef: 'b' },
];
const metric: MetricObservation = {
  name: 'quality',
  unit: 'ratio',
  definitionRef: 'definition',
  status: 'available',
  values: { value: 0 },
  description: '',
  reason: null,
};
const baseline: MeasurementSummary = {
  ref: 'base',
  candidateRef: 'root',
  callId: 'base-call',
  status: 'succeeded',
  coverage: 'complete',
  comparisonKey: 'same',
  startedAt: null,
  finishedAt: null,
  metrics: [metric],
};
const final: MeasurementSummary = {
  ...baseline,
  ref: 'final-score',
  candidateRef: 'final',
  metrics: [{ ...metric, values: { value: 0.7 } }],
};
test('baseline comparison follows ancestry and exact conditions, preserving zero and refusing ambiguous or incompatible records', () => {
  assert.equal(
    comparableBaseline(final, metric, [baseline, final], candidates)?.values
      .value,
    0,
  );
  assert.equal(
    comparableBaseline(
      { ...final, comparisonKey: 'test' },
      metric,
      [baseline],
      candidates,
    ),
    null,
  );
  assert.equal(
    comparableBaseline(
      final,
      { ...metric, definitionRef: 'other' },
      [baseline],
      candidates,
    ),
    null,
  );
  assert.equal(
    comparableBaseline(
      final,
      metric,
      [baseline, { ...baseline, ref: 'repeat' }],
      candidates,
    ),
    null,
  );
  assert.equal(
    comparableBaseline(
      { ...final, coverage: 'partial' },
      metric,
      [baseline],
      candidates,
    ),
    null,
  );
  assert.equal(rootCandidate('final', [candidates[1]!]), null);
  assert.equal(
    rootCandidate('final', [{ ...candidates[1]!, parentRef: 'final' }]),
    null,
  );
});
test('duration uses recorded endpoints without inventing completion', () => {
  assert.equal(
    recordedDuration('2026-10-31T00:00:00Z', '2026-10-31T01:02:03Z'),
    '1h 2m',
  );
  assert.equal(recordedDuration(null, null), 'Not recorded');
  assert.equal(recordedDuration('2026-10-31T00:00:00Z', null), 'Not finished');
  assert.equal(recordedDuration('invalid', 'invalid'), 'Not recorded');
});
