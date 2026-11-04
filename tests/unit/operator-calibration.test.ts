import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeCalibration,
  type CalibrationMeasurement,
} from '../../src/entries/cli/operator-experiments/statistics.js';

function measurements(): CalibrationMeasurement[] {
  return Array.from({ length: 20 }, (_, i) => ({
    measurementRef: `m${i}`,
    experimentId: `e${Math.floor(i / 2)}`,
    runId: `r${i}`,
    comparisonKey: 'same',
    sourceDigest: 'source',
    batch: i < 10 ? 1 : 2,
    candidateMs: i % 2 ? 104 : 100,
    referenceMs: 200,
    warmup: 5,
    repeat: 20,
    fixture: false,
  }));
}
test('calibration uses every measurement and both metrics with sample standard deviation', () => {
  const result = summarizeCalibration(measurements());
  assert.equal(result.passed, true);
  assert.equal(result.candidate.mean, 102);
  assert.ok(Math.abs(result.candidate.cv - 0.020117222598) < 1e-10);
  assert.ok(Math.abs(result.noise! - 4 / 102) < 1e-12);
  assert.ok(Math.abs(result.threshold! - 8 / 102) < 1e-12);
  assert.equal(result.reference.mean, 200);
});
test('calibration rejects incomplete, duplicated, mixed-condition and malformed samples', () => {
  const valid = measurements();
  assert.throws(() => summarizeCalibration(valid.slice(1)), /20/);
  for (const patch of [
    { runId: 'r1' },
    { measurementRef: 'm1' },
    { comparisonKey: 'changed' },
    { sourceDigest: 'changed' },
    { candidateMs: NaN },
    { batch: 2 },
    { repeat: 100 },
  ]) {
    assert.throws(() =>
      summarizeCalibration(
        valid.map((m, i) => (i === 0 ? { ...m, ...patch } : m)),
      ),
    );
  }
});
test('noise gates include the boundary and fail on reference drift or fixture evidence', () => {
  const boundary = measurements().map((m, i) => ({
    ...m,
    candidateMs: i % 2 ? 102.5 : 97.5,
  }));
  assert.equal(summarizeCalibration(boundary).passed, true);
  assert.equal(summarizeCalibration(boundary).threshold, 0.1);
  const drift = measurements().map((m, i) => ({
    ...m,
    candidateMs: i < 10 ? 98.5 : 101.5,
  }));
  assert.equal(summarizeCalibration(drift).passed, true);
  const badReference = measurements().map((m, i) => ({
    ...m,
    referenceMs: i < 10 ? 100 : 110,
  }));
  assert.equal(summarizeCalibration(badReference).passed, false);
  const fixture = summarizeCalibration(
    measurements().map((m) => ({ ...m, fixture: true })),
  );
  assert.equal(fixture.passed, false);
  assert.equal(fixture.threshold, null);
  assert.equal(fixture.numericallyStable, true);
});
