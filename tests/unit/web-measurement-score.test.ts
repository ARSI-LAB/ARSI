import test from 'node:test';
import assert from 'node:assert/strict';
import {
  primaryScore,
  roundAverage,
} from '../../web/features/experiments/measurement-score.js';
import type { MeasurementSummary } from '../../web/api/observation-client.js';

test('primary score prefers the aggregate score and preserves zero and missing values', () => {
  const measurement: MeasurementSummary = {
    ref: 'm',
    candidateRef: 'c',
    callId: 'call',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: null,
    startedAt: null,
    finishedAt: null,
    metrics: [
      {
        name: 'meanReward',
        unit: 'score',
        status: 'available',
        values: { value: 0 },
        description: '',
        definitionRef: 'artifact-score-definition',
        reason: null,
      },
    ],
  };
  assert.equal(primaryScore(measurement), 0);
  const withScore = (value: number): MeasurementSummary => ({
    ...measurement,
    metrics: [{ ...measurement.metrics[0]!, values: { value } }],
  });
  assert.equal(
    roundAverage([[withScore(0), withScore(1)], [withScore(1)]]),
    0.75,
  );
  assert.equal(roundAverage([[], [withScore(0)]]), 0);
  assert.equal(roundAverage([[]]), null);
  assert.equal(primaryScore({ ...measurement, metrics: [] }), null);
  assert.equal(
    primaryScore({
      ...measurement,
      metrics: [{ ...measurement.metrics[0]!, values: { value: null } }],
    }),
    null,
  );
});
