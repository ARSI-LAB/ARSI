import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinalMeasurementMetrics } from '../../web/features/experiments/final-measurement-metrics.tsx';

const metric = (name, value, extra = {}) => ({
  name,
  unit: 'ratio',
  status: 'available',
  values: { value },
  description: '',
  definitionRef: name,
  reason: null,
  ...extra,
});
const measurement = (ref, candidateRef, metrics, extra = {}) => ({
  ref,
  candidateRef,
  callId: 'call',
  status: 'succeeded',
  coverage: 'complete',
  comparisonKey: 'validation',
  startedAt: null,
  finishedAt: null,
  metrics,
  ...extra,
});
const candidates = [
  { ref: 'base', parentRef: null, artifactRef: 'base-artifact' },
  { ref: 'final', parentRef: 'base', artifactRef: 'final-artifact' },
];
function render(result, measurements = []) {
  return renderToStaticMarkup(
    React.createElement(FinalMeasurementMetrics, {
      measurement: result,
      measurements,
      candidates,
    }),
  );
}

test('every returned metric is rendered with its own comparison, including zero and heterogeneous outputs', () => {
  const base = measurement('baseline', 'base', [
    metric('meanReward', 0),
    metric('accuracy', 0.5),
  ]);
  const final = measurement('selected', 'final', [
    metric('meanReward', 0),
    metric('accuracy', 0.75),
  ]);
  const html = render(final, [base, final]);
  assert.match(html, /meanReward \(ratio\)/);
  assert.match(html, /accuracy \(ratio\)/);
  assert.match(html, /<strong>0<\/strong>/);
  assert.match(html, /<strong>\+0.25<\/strong>/);
  const testResult = render(
    measurement('test', 'final', [metric('heldout', 0.6)], {
      comparisonKey: 'test',
    }),
    [base],
  );
  assert.match(testResult, /heldout \(ratio\)/);
  assert.match(testResult, /<strong>0.6<\/strong>/);
  assert.match(testResult, /No comparable baseline recorded/);
  assert.doesNotMatch(testResult, /meanReward/);
});

test('unavailable, structured, missing and failed measurements retain explicit evidence without fabricated scores', () => {
  const html = render(
    measurement('selected', 'final', [
      metric('unavailable', null, {
        status: 'unavailable',
        reason: 'No valid tasks',
      }),
      metric('distribution', null, { values: { p50: 0, p90: 0.9 } }),
    ]),
  );
  assert.match(html, /No valid tasks/);
  assert.match(html, /p50: 0 · p90: 0.9/);
  assert.match(
    render(measurement('missing', 'final', [])),
    /No metrics recorded/,
  );
  const failed = render(
    measurement('failed', 'final', [metric('accuracy', 0.987)], {
      status: 'failed',
    }),
  );
  assert.doesNotMatch(failed, /0.987/);
  assert.match(failed, /<strong>—<\/strong>/);
});
