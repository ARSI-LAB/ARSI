import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Manager } from '../../src/runtime/manager/index.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Manager reports settled cleanup errors and releases the lock after explicit reconciliation', async () => {
  let disposals = 0;
  const fixture = await managerFixture(async () => ({ done: true }), {
    async disposeDriver() {
      disposals++;
      throw new Error('external cleanup failed');
    },
  });
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
    await assert.rejects(fixture.manager.dispose(), /cleanup failed/i);
    await assert.rejects(fixture.manager.dispose(), /cleanup failed/i);
    assert.equal(disposals, 1);
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await assert.rejects(
      fixture.manager.run(recipe, { id: 'test', resume: true }),
      /lock/i,
    );
    await fixture.manager.reconcileCleanup('test');
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'reconciled',
    );
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'test', resume: true })).status,
      'succeeded',
    );
    await fixture.manager.dispose();
    assert.equal(disposals, 1);
  } finally {
    await fixture.manager.reconcileCleanup('test');
    await fixture.dispose();
  }
});

test('Manager refuses cleanup reconciliation while disposal has not settled', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let disposals = 0;
  const fixture = await managerFixture(async () => ({}), {
    budget: { cleanupReserveMs: 20 },
    async disposeDriver() {
      disposals++;
      await gate;
    },
  });
  try {
    await fixture.run();
    await assert.rejects(
      fixture.manager.dispose(),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some(
          (cause: unknown) =>
            cause instanceof Error &&
            /cleanup.*pending|deadline/i.test(cause.message),
        ),
    );
    await assert.rejects(fixture.manager.reconcileCleanup('test'), /pending/);
    release();
    await fixture.manager.dispose();
    assert.equal(disposals, 1);
  } finally {
    release();
    await fixture.dispose();
  }
});

test('another Manager cannot reconcile live cleanup ownership and can reconcile a persisted terminal record', async () => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disposing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fixture = await managerFixture(async () => ({}), {
    async disposeDriver() {
      started();
      await pending;
    },
  });
  const recovered = new Manager({
    registry: fixture.manager.options.registry,
    rootDirectory: fixture.manager.rootDirectory,
  });
  const running = fixture.run();
  try {
    await Promise.race([disposing, running]);
    await assert.rejects(recovered.reconcileCleanup('test'), /lock/i);
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'unconfirmed',
    );
    release();
    await running;
    await fixture.manager.dispose();
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
    await fixture.manager.facts.write('cleanup', 'test', {
      experimentId: 'test',
      status: 'failed',
      error: 'previous process exited after external disposal failed',
    });
    await recovered.reconcileCleanup('test');
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'reconciled',
    );
    assert.equal((await fixture.manager.get('test')).status, 'succeeded');
  } finally {
    release();
    await running.catch(() => {});
    await recovered.dispose();
    await fixture.dispose();
  }
});

test('reconciliation persists before releasing ownership and concurrent retries never repeat disposal', async () => {
  let disposals = 0;
  const fixture = await managerFixture(async () => ({}), {
    async disposeDriver() {
      disposals++;
      throw new Error('cleanup needs confirmation');
    },
  });
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  let failReconciliation = true;
  try {
    await fixture.run();
    fixture.manager.facts.write = async (kind, id, value) => {
      if (
        kind === 'cleanup' &&
        id === 'test' &&
        value.status === 'reconciled' &&
        failReconciliation
      ) {
        failReconciliation = false;
        throw new Error('reconciliation receipt unavailable');
      }
      await write(kind, id, value);
    };
    await assert.rejects(
      fixture.manager.reconcileCleanup('test'),
      /receipt unavailable/,
    );
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await assert.rejects(
      fixture.manager.run(recipe, { id: 'test', resume: true }),
      /lock/i,
    );
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'failed',
    );
    await Promise.all([
      fixture.manager.reconcileCleanup('test'),
      fixture.manager.reconcileCleanup('test'),
    ]);
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'reconciled',
    );
    assert.equal(disposals, 1);
  } finally {
    fixture.manager.facts.write = write;
    await fixture.manager.reconcileCleanup('test');
    await fixture.dispose();
  }
});

for (const status of ['running', 'failed', 'cancelled', 'succeeded']) {
  test(`fresh Manager refuses ${status} resume with unresolved cleanup until reconciliation`, async () => {
    let executions = 0;
    const fixture = await managerFixture(async () => {
      executions++;
      return {};
    });
    const recovered = new Manager({
      registry: fixture.manager.options.registry,
      rootDirectory: fixture.manager.rootDirectory,
    });
    try {
      await fixture.run();
      const previous = await fixture.manager.get('test');
      await fixture.manager.facts.write('experiments', 'test', {
        ...previous,
        status,
      });
      await fixture.manager.facts.write('cleanup', 'test', {
        experimentId: 'test',
        status: 'unconfirmed',
        error: 'prior process exited during cleanup',
      });
      const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
      await assert.rejects(
        recovered.run(recipe, { id: 'test', resume: true }),
        /cleanup is unresolved/,
      );
      assert.equal(executions, 1);
      assert.equal((await fixture.manager.get('test')).status, status);
      await recovered.reconcileCleanup('test');
      assert.equal(
        (await recovered.run(recipe, { id: 'test', resume: true })).status,
        'succeeded',
      );
      assert.equal(executions, 1);
    } finally {
      await recovered.dispose();
      await fixture.dispose();
    }
  });
}

test('cleanup ownership is persisted before calling a plugin disposer', async () => {
  let inspected = false;
  const fixture = await managerFixture(async () => ({}), {
    async disposeDriver() {
      assert.equal(
        (await fixture.manager.facts.read('cleanup', 'test')).status,
        'unconfirmed',
      );
      inspected = true;
    },
  });
  try {
    await fixture.run();
    await fixture.manager.dispose();
    assert.equal(inspected, true);
  } finally {
    await fixture.manager.reconcileCleanup('test');
    await fixture.dispose();
  }
});

test('persisted cleanup can be reconciled after startup failed before creating an experiment record', async () => {
  const fixture = await managerFixture(async () => ({}));
  try {
    await fixture.manager.facts.write('cleanup', 'startup', {
      experimentId: 'startup',
      status: 'unconfirmed',
    });
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await assert.rejects(
      fixture.manager.run(recipe, { id: 'startup' }),
      /cleanup is unresolved/,
    );
    await fixture.manager.reconcileCleanup('startup');
    await assert.rejects(fixture.manager.get('startup'), /ENOENT/);
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'startup' })).status,
      'succeeded',
    );
    await fixture.manager.facts.write('cleanup', 'unknown', {
      experimentId: 'unknown',
      status: 'unconfirmed',
    });
    await fixture.manager.facts.write('experiments', 'unknown', {
      id: 'unknown',
      status: 'unrecognized',
    });
    await assert.rejects(
      fixture.manager.reconcileCleanup('unknown'),
      /status is unsupported/,
    );
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'unknown')).status,
      'unconfirmed',
    );
  } finally {
    await fixture.dispose();
  }
});

test('cleanup timeout cannot overwrite a committed successful cleanup receipt', async () => {
  let release!: () => void;
  const publication = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await managerFixture(async () => ({}), {
    budget: { cleanupReserveMs: 30 },
  });
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    await write(kind, id, value);
    if (kind === 'cleanup' && id === 'test' && value.status === 'succeeded')
      await publication;
  };
  try {
    await fixture.run();
    release();
    await fixture.manager.dispose();
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
  } finally {
    release();
    fixture.manager.facts.write = write;
    await fixture.dispose();
  }
});
