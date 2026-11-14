import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvaluationProgress } from '../../web/features/experiments/evaluation-progress.tsx';

function render(measurements) {
  return renderToStaticMarkup(
    React.createElement(EvaluationProgress, {
      id: 'experiment',
      measurements,
      evaluationLabel: (ref) => `Evaluation ${ref}`,
    }),
  );
}

const measurement = {
  ref: 'validation',
  candidateRef: 'candidate',
  callId: 'call',
  status: 'succeeded',
  coverage: 'complete',
  comparisonKey: 'validation-set',
  startedAt: '2026-11-14T00:00:00Z',
  finishedAt: '2026-11-14T00:01:00Z',
  metrics: [
    {
      name: 'meanReward',
      unit: 'ratio',
      definitionRef: 'definition',
      description: '',
      status: 'available',
      reason: null,
      values: { value: 0 },
    },
  ],
};

test('results show recorded evidence without final output, preserve zero and expose failed and partial records', () => {
  const html = render([
    measurement,
    { ...measurement, ref: 'partial', coverage: 'partial' },
    { ...measurement, ref: 'failed', status: 'failed', metrics: [] },
  ]);
  assert.match(html, /Recorded evaluations<\/span><strong>3<\/strong>/);
  assert.match(
    html,
    /Succeeded with complete coverage<\/span><strong>1<\/strong>/,
  );
  assert.match(html, /Other status or coverage<\/span><strong>2<\/strong>/);
  assert.match(html, /data-status="failed"/);
  assert.match(html, />partial<\/td>/);
  assert.match(html, /<dd>0<\/dd>/);
  assert.match(html, /No metrics recorded/);
  assert.match(html, /measurement=validation/);
  assert.match(html, /different evaluation sets are shown separately/);
});

test('results offer a truthful empty state and limit the recent list without losing full-history navigation', () => {
  assert.match(render([]), /No evaluations have been saved yet/);
  const html = render(
    Array.from({ length: 7 }, (_, i) => ({
      ...measurement,
      ref: `record-${i}`,
      finishedAt: `2026-11-14T00:0${i}:00Z`,
    })),
  );
  assert.match(html, /Recorded evaluations<\/span><strong>7<\/strong>/);
  assert.match(html, /Evaluation record-6/);
  assert.doesNotMatch(html, /Evaluation record-[01]/);
  assert.ok(
    html.indexOf('Evaluation record-6') < html.indexOf('Evaluation record-2'),
  );
  assert.match(html, /View all evaluations/);
});
