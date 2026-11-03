import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
    testRevision?: number;
    [annotation]?: string;
  }
}
test('derived contexts retain typed extensions, symbols and live getters without changing siblings', () => {
  let revision = 1;
  const root = new RuntimeContext().extend({
    testTrace: 'root',
    [annotation]: 'inherited',
    get testRevision() {
      return revision;
    },
    get cleanup() {
      return AbortSignal.timeout(revision * 1000);
    },
  });
  const left = root.extend({ testTrace: 'left' });
  const right = root.extend({ testTrace: 'right' });
  const cleanup = left.extend({ signal: left.cleanup });
  revision = 2;
  assert.equal(cleanup.testRevision, 2);
  assert.equal(cleanup.testTrace, 'left');
  assert.equal(cleanup[annotation], 'inherited');
  assert.notEqual(cleanup.cleanup, cleanup.cleanup);
  left.testTrace = 'updated';
  assert.equal(root.testTrace, 'root');
  assert.equal(right.testTrace, 'right');
  assert.equal(cleanup.testTrace, 'updated');
  assert.equal(cleanup instanceof RuntimeContext, true);
});

test('Manager inherits extensions and execution constraints through concurrent child calls', async () => {
  const seen: RuntimeContext[] = [];
  const factoryContexts: RuntimeContext[] = [];
  const worker: OperationDefinition = {
    id: 'test.context-worker',
    contract: defineContract({
      id: 'contract.context-worker',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: { type: 'object' },
    async create(_config, context) {
      factoryContexts.push(context);
      assert.equal(context.testTrace, 'experiment');
      assert.equal(context.bindingId, 'worker');
      return {
        async execute(input, context) {
          seen.push(context);
          await Promise.resolve();
          assert.equal(context.testTrace, context[annotation]);
          assert.equal(context.bindingId, 'worker');
          assert.equal(context.scope?.id, 'local');
          assert.equal(context.signal, context.scope?.signal);
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
      const signal = AbortSignal.any([
        context.signal,
        new AbortController().signal,
      ]);
      const scope = {
        id: 'local',
        signal,
        limits: { modelCalls: 2, elapsedWallMs: 1000, evidenceBytes: 1000 },
      };
      await Promise.all(
        ['a', 'b'].map((branch) =>
          context
            .extend({
              testTrace: branch,
              [annotation]: branch,
              scope,
              signal,
            })
            .invoke('worker', { branch }),
        ),
      );
      assert.equal(context.testTrace, 'experiment');
      assert.equal(context.scope, undefined);
      return {};
    },
    {
      context: base,
      plugins: [worker],
      bindings: { worker: { ref: worker.id, config: {} } },
      budget: { modelCalls: 2 },
    },
  );
  try {
    assert.equal(fixture.manager.context.testTrace, 'experiment');
    assert.equal((await fixture.run()).status, 'succeeded');
    assert.deepEqual(seen.map((context) => context.testTrace).sort(), [
      'a',
      'b',
    ]);
    assert.equal(new Set(seen.map((context) => context.callId)).size, 2);
    assert.equal(factoryContexts.length, 1);
    assert.ok(
      seen.every((context) => context.callId !== factoryContexts[0]!.callId),
    );
    assert.equal(base.testTrace, 'experiment');
    const budget = await fixture.manager.facts.read('budgets', 'test');
    assert.equal(budget.modelCalls, 2);
    assert.deepEqual(budget.scopes, {
      local: { operations: 2, modelCalls: 2 },
    });
    for (const receipt of await fixture.manager.facts.list('calls')) {
      assert.equal(receipt.testTrace, undefined);
    }
  } finally {
    await fixture.dispose();
  }
});

test('experiment context overrides stay local while Manager supplies its services', async () => {
  const base = new RuntimeContext().extend({ testTrace: 'runtime' });
  const fixture = await managerFixture(
    async (context) => {
      assert.equal(context.artifacts, fixture.manager.artifacts);
      assert.equal(typeof context.invoke, 'function');
      return { trace: context.testTrace ?? null };
    },
    { context: base },
  );
  try {
    const customized = await fixture.manager.run(
      join(fixture.manager.rootDirectory, 'recipe.yaml'),
      {
        id: 'customized',
        context: fixture.manager.context.extend({ testTrace: 'experiment' }),
      },
    );
    assert.deepEqual(customized.output, { trace: 'experiment' });
    const ordinary = await fixture.run();
    assert.deepEqual(ordinary.output, { trace: 'runtime' });
    assert.equal(fixture.manager.context.testTrace, 'runtime');
    assert.equal(base.testTrace, 'runtime');
  } finally {
    await fixture.dispose();
  }
});
