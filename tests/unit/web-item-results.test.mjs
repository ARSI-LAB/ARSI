import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemResults } from '../../web/features/experiments/item-results.tsx';
import { MeasurementMetrics } from '../../web/features/experiments/measurement-metrics.tsx';

function item(status, coverage, value) {
  return {
    ref: 'measurement',
    candidateRef: 'candidate',
    callId: 'call',
    status,
    coverage,
    comparisonKey: null,
    startedAt: null,
    finishedAt: null,
    item: {
      id: status,
      subjectKind: 'task',
      subjectId: `benchmark/${status}`,
      parametersRef: null,
    },
    metrics: [
      {
        name: 'score',
        unit: 'ratio',
        description: '',
        definitionRef: 'definition',
        status: 'available',
        reason: null,
        values: { value },
      },
    ],
  };
}
const render = (records) =>
  renderToStaticMarkup(
    React.createElement(ItemResults, {
      measurementRef: 'measurement',
      records,
    }),
  );

test('item results preserve zero, individual failure status and incomplete coverage', () => {
  const html = render([
    item('succeeded', 'complete', 0),
    item('failed', 'partial', 0.98765),
    item('cancelled', 'none', 0.87654),
    item('unknown', 'none', 0.76543),
  ]);
  assert.match(html, />0<\/dd>/);
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown'])
    assert.ok(html.includes(`data-status="${status}"`));
  for (const coverage of ['complete', 'partial', 'none'])
    assert.ok(html.includes(`>${coverage}</td>`));
  assert.equal((html.match(/No valid score recorded\./g) ?? []).length, 3);
  assert.doesNotMatch(html, /0\.98|0\.87|0\.76/);
  assert.match(html, /benchmark\/succeeded/);
});

test('item results exclude aggregate and other measurements and show missing evidence explicitly', () => {
  const record = item('succeeded', 'complete', 0.5);
  const records = [
    { ...record, item: null },
    { ...record, ref: 'other' },
  ];
  assert.match(render(records), /No item results recorded\./);
  assert.doesNotMatch(render(records), /<table/);
  assert.match(render([{ ...record, metrics: [] }]), /No metrics recorded\./);
});

test('metrics that share a display label retain their distinct recorded names', () => {
  const metric = item('succeeded', 'complete', 0).metrics[0];
  const renderMetrics = (metrics) =>
    renderToStaticMarkup(React.createElement(MeasurementMetrics, { metrics }));
  const html = renderMetrics([
    metric,
    { ...metric, name: 'reward.reward' },
    { ...metric, name: 'reward.overall' },
  ]);
  assert.match(html, /Score<span[^>]*> · score<\/span>/);
  assert.match(html, /Score<span[^>]*> · reward\.reward<\/span>/);
  assert.match(html, /Score<span[^>]*> · reward\.overall<\/span>/);
  assert.match(renderMetrics([metric]), /<dt>Score<\/dt>/);
});
