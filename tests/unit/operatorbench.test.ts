import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('invalid SDK templates and operator binding conflicts fail before writing files or charging', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-operator-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = {
    directory: fileURLToPath(
      new URL(
        '../../examples/artifacts/kernel/transpose-copy/task/',
        import.meta.url,
      ),
    ),
  };
  let charges = 0;
  const context = new RuntimeContext().extend({
    directory,
    signal: new AbortController().signal,
    async charge() {
      charges++;
    },
    async withInstance(_ref, _capability, use) {
      return use({
        kind: 'kernel-source',
        format: 'triton-ascend',
        entryPoint: 'kernel_function',
        directory,
        artifactRef: 'fixture',
        sourceDigest: 'a'.repeat(64),
      });
    },
  });
  const input = {
    action: 'evaluate' as const,
    candidateRef: 'candidate',
    caseIds: ['fixed'],
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
    await assert.rejects(operation.execute(input, context), error);
    await operation.dispose();
  }
  assert.equal(charges, 0);
  assert.deepEqual(await readdir(directory), []);
});
