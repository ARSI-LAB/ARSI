import test from 'node:test';
import assert from 'node:assert/strict';
import { route, parseRoute } from '../../web/app/routing.js';
test('Recipe and existing Configuration links resolve to the same saved Recipe', () => {
  assert.equal(
    parseRoute('#experiment=example&view=configuration').view,
    'recipe',
  );
  assert.equal(parseRoute(route('example', 'recipe')).view, 'recipe');
});

test('browser filters and file selection round-trip without injecting extra routes or invalid offsets', () => {
  const state = {
    search: 'a b&?#',
    status: 'failed',
    offset: 50,
    scope: '["task","x/y"]',
    metric: '["quality","ratio"]',
    condition: 'different conditions',
    statistic: 'p95',
    display: 'values',
    content: 'changes',
    diffFile: 'skills/check/SKILL.md',
    point: '["measurement-7",null]',
    chartOffset: 20,
    fileSearch: 'README',
    file: 'a/b.md',
    directory: 'a',
    call: 'call /?&2',
  };
  const parsed = parseRoute(
    route('experiment', 'calls', 'candidate-1', 'artifact:ref', state),
  );
  for (const [key, value] of Object.entries(state))
    assert.equal(parsed[key as keyof typeof state], value);
  assert.equal(parsed.id, 'experiment');
  assert.equal(
    parseRoute(
      route(null, 'overview', undefined, undefined, { search: 'mock' }),
    ).search,
    'mock',
  );
  for (const value of ['-1', 'NaN', '1.5', '999999999999999999999'])
    assert.equal(parseRoute(`#experiment=x&offset=${value}`).offset, undefined);
});
