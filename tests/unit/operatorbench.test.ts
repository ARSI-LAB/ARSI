import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext } from '../../src/contracts/index.js';
import { createOperatorbench } from '../../src/plugins/evaluator-operatorbench/service.js';

test('operatorbench requires its task directory and an SDK benchmark', async () => {
  await assert.rejects(
    createOperatorbench({ benchmark: 'kernel' }, new RuntimeContext()),
    /required property 'task'/,
  );
  await assert.rejects(
    createOperatorbench(
      { mode: 'sdk', task: { directory: '/unused' } },
      new RuntimeContext(),
    ),
    /required property 'benchmark'/,
  );
});

test('operatorbench rejects invalid SDK templates and ownership conflicts at creation', async () => {
  const context = new RuntimeContext();
  const task = { directory: '/unused' };
  for (const [overrides, error] of [
    [{ fixtures: 'unused' }, /unknown field fixtures/],
    [{ services: {} }, /services is owned by RSI/],
    [{ benchmark: 'agentx' }, /benchmark.name=kernel/],
    [
      { benchmark: { name: 'kernel', config: { manifest: 'external.json' } } },
      /manifest is owned by RSI/,
    ],
    [{ output: { directory: 'external' } }, /output.directory is owned by RSI/],
    [
      {
        services: {
          default: {
            model: 'fixture',
            base_url: 'unused',
            api_key: '${TEST_KEY}',
          },
        },
      },
      /services is owned by RSI/,
    ],
  ] as const) {
    await assert.rejects(
      createOperatorbench({ task, benchmark: 'kernel', ...overrides }, context),
      error,
    );
  }
});
