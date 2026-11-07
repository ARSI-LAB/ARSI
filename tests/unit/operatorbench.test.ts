import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('operatorbench rejects invalid bound configs before acquiring a candidate, writing inputs or charging', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-invalid-operator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = new RuntimeContext().extend({
    directory,
    signal: new AbortController().signal,
    withInstance: async () =>
      assert.fail('Invalid config acquired a candidate'),
    charge: async () => assert.fail('Invalid config charged the budget'),
  });
  const task = {
    directory: fileURLToPath(
      new URL(
        '../../examples/artifacts/kernel/transpose-copy/task/',
        import.meta.url,
      ),
    ),
  };
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
    const operation = await createOperatorbench(
      { task, benchmark: 'kernel', ...overrides },
      context,
    );
    try {
      await assert.rejects(
        operation.execute(
          { action: 'evaluate', candidateRef: 'candidate', caseIds: ['fixed'] },
          context,
        ),
        error,
      );
    } finally {
      await operation.dispose();
    }
  }
  assert.deepEqual(await readdir(directory), []);
});
