import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContext,
  defineContract,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { managerFixture } from '../helpers/manager-fixture.js';

const annotation = Symbol('test.annotation');
declare module '../../src/contracts/index.js' {
  interface RuntimeContext {
    testTrace?: string;
    [annotation]?: string;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/context-notice'(branch: string): Promise<void>;
  }
}

test('Manager carries extensions through concurrent calls and independent listeners using the same service context', async () => {
  const seen: RuntimeContext[] = [];
  const notices: RuntimeContext[] = [];
  const contract = defineContract({
    id: 'contract.context-test',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  const worker: OperationDefinition = {
    id: 'test.context-worker',
    contract,
    configSchema: { type: 'object' },
    async create(_config, context) {
      assert.equal(context.testTrace, 'experiment');
      assert.equal(typeof context.invoke, 'function');
      context.event.on('test/context-notice', async (branch, context) => {
        assert.equal(context.testTrace, 'experiment');
        assert.equal(context[annotation], undefined);
        assert.equal(context.scope, undefined);
        notices.push(context);
        await context
          .extend({
            testTrace: branch,
            [annotation]: branch,
          })
          .invoke('worker', { branch });
        assert.equal(context.testTrace, 'experiment');
      });
      return {
        async execute(input, context) {
          seen.push(context);
          await Promise.resolve();
          assert.equal(context.testTrace, context[annotation]);
          assert.equal(context.bindingId, 'worker');
          await context.charge('modelCalls', 1);
          return input;
        },
        async dispose() {},
      };
    },
  };
  const base = new RuntimeContext().extend({ testTrace: 'experiment' });
  const fixture = await managerFixture(
    async (context) => {
      const scope = {
        id: 'test-local',
        signal: context.signal,
        limits: { modelCalls: 2, elapsedWallMs: 1000, evidenceBytes: 1000 },
      };
      await Promise.all(
        ['a', 'b'].map((branch) =>
          context
            .extend({
              testTrace: branch,
              [annotation]: branch,
              scope,
            })
            .invoke('worker', { branch }),
        ),
      );
      await Promise.all(
        ['c', 'd'].map((branch) =>
          context.event.parallel('test/context-notice', branch),
        ),
      );
      assert.equal(context.testTrace, 'experiment');
      return {};
    },
    {
      context: base,
      plugins: [worker],
      bindings: { worker: { ref: worker.id, config: {} } },
      budget: { modelCalls: 4 },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
    assert.deepEqual(seen.map((context) => context.testTrace).sort(), [
      'a',
      'b',
      'c',
      'd',
    ]);
    assert.equal(new Set(seen.map((context) => context.callId)).size, 4);
    assert.equal(new Set(notices.map((context) => context.callId)).size, 2);
    assert.equal(base.testTrace, 'experiment');
    const budget = await fixture.manager.facts.read('budgets', 'test');
    assert.equal(budget.modelCalls, 4);
    assert.deepEqual(budget.scopes, {
      'test-local': { operations: 2, modelCalls: 2 },
    });
    const receipts = await fixture.manager.facts.list('calls');
    for (const context of notices) {
      assert.ok(
        receipts.some((receipt) => receipt.parentCallId === context.callId),
      );
      await assert.rejects(context.invoke('worker', {}), /no longer accepts/);
    }
    for (const receipt of receipts) {
      assert.equal(receipt.testTrace, undefined);
    }
  } finally {
    await fixture.dispose();
  }
});
