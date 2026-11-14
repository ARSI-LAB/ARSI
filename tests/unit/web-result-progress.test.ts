import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ExperimentOverview,
  MeasurementSummary,
} from '../../web/api/observation-client.js';

const execute = promisify(execFile);
const experiment: ExperimentOverview = {
  id: 'experiment',
  recipeId: 'recipe',
  status: 'running',
  startedAt: null,
  finishedAt: null,
  error: null,
  observedAt: '',
  usage: null,
  limits: {},
  output: null,
};
function measurement(
  status = 'succeeded',
  coverage = 'complete',
): MeasurementSummary {
  return {
    ref: 'measurement-zero',
    candidateRef: 'candidate',
    callId: 'call',
    status,
    coverage,
    comparisonKey: null,
    startedAt: null,
    finishedAt: null,
    metrics: [
      {
        name: 'score',
        unit: 'native',
        status: 'available',
        description: '',
        definitionRef: 'definition',
        reason: null,
        values: { value: 0 },
      },
    ],
  };
}
async function render(
  value: ExperimentOverview,
  measurements: MeasurementSummary[],
  hasFinalOutput: boolean,
): Promise<string> {
  const component = new URL(
    '../../web/features/experiments/result-progress.tsx',
    import.meta.url,
  ).href;
  const script = `
    import {createElement} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {ResultProgress} from ${JSON.stringify(component)};
    process.stdout.write(renderToStaticMarkup(createElement(ResultProgress,
      ${JSON.stringify({ experiment: value, measurements, hasFinalOutput })})));
  `;
  const { stdout } = await execute(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    script,
  ]);
  return stdout;
}

test('running experiments expose intermediate evaluations and preserve valid zero scores', async () => {
  const html = await render(experiment, [measurement()], false);
  assert.match(html, /Experiment in progress/);
  assert.match(html, /intermediate observations/);
  assert.match(html, /Score: 0/);
  assert.match(html, /measurement=measurement-zero/);
  assert.match(html, /View all evaluations/);
  assert.doesNotMatch(html, /No final output saved/);
});

test('failed and partial evaluations are retained without presenting invalid scores as zero', async () => {
  const html = await render(
    { ...experiment, status: 'failed' },
    [measurement('failed', 'partial')],
    false,
  );
  assert.match(html, /Experiment failed/);
  assert.match(html, /Score: Unavailable/);
  assert.match(html, /Coverage: partial/);
  assert.doesNotMatch(html, /Score: 0/);
});

test('startup failures and completed experiments have distinct result states', async () => {
  const failed = await render({ ...experiment, status: 'failed' }, [], false);
  assert.match(failed, /No evaluations were recorded/);
  assert.match(failed, /View call history/);
  const complete = await render(
    { ...experiment, status: 'succeeded' },
    [measurement()],
    true,
  );
  assert.match(complete, /Final results saved/);
  assert.doesNotMatch(complete, /intermediate observations/);
});
