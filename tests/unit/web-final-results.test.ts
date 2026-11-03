import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  MeasurementSummary,
  ResultReference,
} from '../../web/api/observation-client.js';
import { finalResults } from '../../web/features/experiments/final-results.js';

function measurement(
  ref: string,
  candidateRef: string,
  value: number,
): MeasurementSummary {
  return {
    ref,
    candidateRef,
    callId: 'call',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: 'conditions',
    startedAt: null,
    finishedAt: null,
    metrics: [
      {
        name: 'score',
        unit: 'native',
        status: 'available',
        values: { value },
        description: '',
        definitionRef: 'definition',
        reason: null,
      },
    ],
  };
}
test('final results follow returned nested deliveries, excluding baselines and later or higher unrelated scores', () => {
  const references: ResultReference[] = [
    { kind: 'candidate', ref: 'baseline', path: '/baseline' },
    { kind: 'candidate', ref: 'delivery', path: '/deliveries/0/candidateRef' },
    {
      kind: 'measurement',
      ref: 'chosen',
      path: '/deliveries/0/measurementRef',
    },
    { kind: 'measurement', ref: 'chosen', path: '/anotherRecordedReference' },
  ];
  const final = finalResults(references, [
    measurement('baseline-score', 'baseline', 1),
    measurement('chosen', 'delivery', 0),
    measurement('last', 'unrelated', 100),
  ]);
  assert.deepEqual(final.candidates, ['delivery']);
  assert.equal(final.scores.length, 1);
  assert.equal(final.scores[0]!.measurement.metrics[0]!.values.value, 0);
  assert.deepEqual(final.scores[0]!.paths, [
    '/deliveries/0/measurementRef',
    '/anotherRecordedReference',
  ]);
});
test('training and test results stay separate; absent or missing outputs never substitute arbitrary measurements', () => {
  const records = [
    measurement('train', 'candidate', 0.8),
    measurement('test', 'candidate', 0.7),
  ];
  const final = finalResults(
    [
      { kind: 'measurement', ref: 'train', path: '/measurementRef' },
      { kind: 'measurement', ref: 'test', path: '/testMeasurementRef' },
    ],
    records,
  );
  assert.deepEqual(
    final.scores.map(({ measurement }) => measurement.ref),
    ['train', 'test'],
  );
  assert.deepEqual(finalResults([], records), {
    candidates: [],
    scores: [],
    missingMeasurements: [],
  });
  assert.deepEqual(
    finalResults(
      [{ kind: 'measurement', ref: 'missing', path: '/result' }],
      records,
    ),
    { candidates: [], scores: [], missingMeasurements: ['missing'] },
  );
});
