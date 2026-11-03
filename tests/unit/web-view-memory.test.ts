import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberView, viewRoute } from '../../web/app/view-memory.js';
import { parseRoute, route } from '../../web/app/routing.js';

test('tab return restores browser-only chart, call and diff choices per experiment and view', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const chart = route('experiment', 'overview', undefined, undefined, {
    point: '["evaluation-3",null]',
    metric: '["score","ratio"]',
    scope: 'aggregate',
    condition: 'train',
    statistic: 'value',
    chartOffset: 20,
    display: 'values',
  });
  rememberView(chart, storage);
  const candidate = route(
    'experiment',
    'candidates',
    'candidate-a',
    undefined,
    { content: 'changes', diffFile: 'skills/check/SKILL.md' },
  );
  rememberView(candidate, storage);
  rememberView(
    route('experiment', 'calls', undefined, undefined, {
      call: 'call-3',
      status: 'failed',
      search: 'evaluate',
      offset: 50,
    }),
    storage,
  );
  rememberView(
    route('other', 'overview', undefined, undefined, { point: 'other' }),
    storage,
  );
  assert.equal(viewRoute('experiment', 'overview', storage), chart);
  assert.equal(viewRoute('experiment', 'candidates', storage), candidate);
  const calls = parseRoute(viewRoute('experiment', 'calls', storage));
  assert.equal(calls.call, 'call-3');
  assert.equal(calls.offset, 50);
  assert.equal(calls.status, 'failed');
  assert.equal(
    viewRoute('experiment', 'recipe', storage),
    route('experiment', 'recipe'),
  );
  assert.equal(
    parseRoute(viewRoute('other', 'overview', storage)).point,
    'other',
  );
});
test('stored navigation cannot restore another experiment/view or introduce external navigation', () => {
  for (const value of [
    'javascript:alert(1)',
    '#experiment=foreign&view=overview',
    '#experiment=experiment&view=calls',
  ]) {
    const storage = { getItem: () => value, setItem: () => {} };
    assert.equal(
      viewRoute('experiment', 'overview', storage),
      route('experiment', 'overview'),
    );
  }
  const denied = {
    getItem: (): string | null => {
      throw new Error('Storage unavailable');
    },
    setItem: () => {
      throw new Error('Storage unavailable');
    },
  };
  assert.doesNotThrow(() => rememberView(route('experiment'), denied));
  assert.equal(
    viewRoute('experiment', 'overview', denied),
    route('experiment', 'overview'),
  );
});
