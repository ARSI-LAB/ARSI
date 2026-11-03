import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
  RuntimeContext,
  type Operation,
  type EventPipeline,
} from '../../src/contracts/index.js';
import {
  ManagedEvents,
  type EventDiagnostic,
} from '../../src/runtime/services/events.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { defineContract } from '../../src/contracts/contract.js';

interface DispatchThis {
  label: string;
  [Context.filter]?(context: Context): boolean;
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/value'(
      this: DispatchThis,
      value: number,
    ): number | false | null | undefined;
    'test/wait'(value: number): Promise<string | false | undefined>;
    'test/chain'(value: string, next: () => Promise<string>): Promise<string>;
    'test/notice'(value: number): void;
  }
}
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const diagnostics: EventDiagnostic[] = [];
  const contexts: RuntimeContext[] = [];
  const service = new ManagedEvents({
    context(bindingId, listenerId, signal) {
      const context = new RuntimeContext().extend({
        experimentId: 'experiment',
        bindingId,
        callId: listenerId,
        idempotencyKey: listenerId,
        directory: '/unused',
        signal,
        cleanup: signal,
      });
      contexts.push(context);
      return context;
    },
    diagnostic(info) {
      diagnostics.push(info);
    },
  });
  const add = (bindingId: string, register: (event: EventPipeline) => void) => {
    const scope = service.prepare(bindingId);
    register(scope.event);
    service.activate(scope);
    return scope;
  };
  return { service, contexts, diagnostics, add };
}

test('subscriptions activate with the instance and unsubscribe without changing admitted dispatches', async () => {
  const { service, add } = fixture();
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const first = service.prepare('first');
  const cancelled = first.event.on('test/notice', () =>
    calls.push('cancelled'),
  );
  assert.equal(cancelled(), true);
  assert.equal(cancelled(), false);
  first.event.on('test/wait', async (_value, ctx) => {
    assert.equal(ctx.event, first.event);
    entered.resolve();
    await gate.promise;
    calls.push('first');
    return undefined;
  });
  first.event.emit('test/notice', 0);
  assert.equal(calls.length, 0);
  service.activate(first);
  let remove!: () => boolean;
  const second = add('second', (event) => {
    remove = event.on('test/wait', async () => {
      calls.push('second');
      return undefined;
    });
    event.on('test/wait', async () => {
      calls.push('third');
      return undefined;
    });
  });
  const running = service.event.serial('test/wait', 0);
  await entered.promise;
  assert.equal(remove(), true);
  assert.equal(remove(), false);
  second.event.on('test/wait', async () => {
    calls.push('fourth');
    return undefined;
  });
  gate.resolve();
  await running;
  assert.deepEqual(calls, ['first', 'second', 'third']);
  calls.length = 0;
  await service.event.serial('test/wait', 1);
  assert.deepEqual(calls, ['first', 'third', 'fourth']);
  service.deactivate(second);
  assert.throws(
    () => second.event.on('test/notice', () => {}),
    /scope is closed/,
  );
  assert.throws(() => service.activate(second), /scope is closed/);
  service.release(second);
  await service.dispose();
});

test('managed Cordis keeps synchronous returns, bail values, this and native filtering', async () => {
  const { service, add } = fixture();
  const calls: string[] = [];
  const scopeA = add('a', (event) => {
    event.on('test/value', function (value, context) {
      calls.push(`${this.label}:${context.bindingId}:${value}`);
      return false;
    });
  });
  add('b', (event) => {
    event.on('test/value', (value) => {
      calls.push('b');
      return value;
    });
  });
  add('c', (event) => {
    event.on('test/value', () => {
      calls.push('c');
      return 9;
    });
  });
  assert.equal(service.event.bail({ label: 'dispatch' }, 'test/value', 0), 0);
  assert.deepEqual(calls, ['dispatch:a:0', 'b']);
  calls.length = 0;
  const dispatchThis: DispatchThis = {
    label: 'filtered',
    [Context.filter](context) {
      return context === scopeA.context;
    },
  };
  assert.equal(service.event.bail(dispatchThis, 'test/value', 3), undefined);
  assert.deepEqual(calls, ['filtered:a:3']);
  assert.equal(service.pending, 0);
  await service.dispose();
});

test('serial and parallel use the locked Cordis short-circuit and all-settled behavior', async () => {
  const { service, add } = fixture();
  const calls: number[] = [];
  add('a', (event) => {
    event.on('test/wait', async () => {
      calls.push(1);
      return false;
    });
  });
  add('b', (event) => {
    event.on('test/wait', async () => {
      calls.push(2);
      return 'accepted';
    });
  });
  add('c', (event) => {
    event.on('test/wait', async () => {
      calls.push(3);
      return undefined;
    });
  });
  assert.equal(await service.event.serial('test/wait', 0), 'accepted');
  assert.deepEqual(calls, [1, 2]);
  calls.length = 0;
  await service.event.parallel('test/wait', 0);
  assert.deepEqual(calls, [1, 2, 3]);
  const hold = deferred();
  add('failure', (event) => {
    event.on('test/wait', async () => {
      throw new Error('parallel failed');
    });
  });
  add('slow', (event) => {
    event.on('test/wait', async () => {
      await hold.promise;
      calls.push(4);
      return undefined;
    });
  });
  let settled = false;
  const result = service.event.parallel('test/wait', 0).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  hold.resolve();
  await assert.rejects(result, AggregateError);
  assert.ok(calls.includes(4));
  await service.dispose();
});

test('waterfall preserves downstream transformation, exception recovery and repeated native next', async () => {
  const { service, add } = fixture();
  const calls: string[] = [];
  add('a', (event) => {
    event.on('test/chain', async (value, next) => {
      calls.push(value);
      return `outer:${await next()}`;
    });
  });
  add('b', (event) => {
    event.on('test/chain', async (_value, next) => {
      calls.push('b');
      return `${await next()}:${await next()}`;
    });
  });
  assert.equal(
    await service.event.waterfall('test/chain', 'input', async () => 'inner'),
    'outer:inner:inner',
  );
  assert.deepEqual(calls, ['input', 'b']);
  const recovery = add('a', (event) => {
    event.on('test/chain', async (_value, next) => {
      try {
        return await next();
      } catch {
        return 'recovered';
      }
    });
  });
  add('b', (event) => {
    event.on('test/chain', async () => {
      throw new Error('downstream');
    });
  });
  assert.equal(
    await service.event.waterfall('test/chain', '', async () => 'unused'),
    'recovered',
  );
  assert.equal(recovery.active, true);
  await service.dispose();
});

test('custom asynchronous rejection retains native promise identity and propagation in waiting dispatches', async () => {
  const { service, diagnostics, add } = fixture();
  const native = new Context();
  const failure = new Error('custom rejection');
  const rejected: Promise<string> = Promise.reject(failure);
  add('a', (event) => {
    event.on('test/wait', () => rejected);
    event.on('test/chain', () => rejected);
  });
  native.on('test/wait', () => rejected);
  native.on('test/chain', () => rejected);
  assert.equal(service.event.bail('test/wait', 0), rejected);
  assert.equal(native.bail('test/wait', 0), rejected);
  assert.equal(
    service.event.waterfall('test/chain', '', async () => 'unused'),
    rejected,
  );
  assert.equal(
    native.waterfall('test/chain', '', async () => 'unused'),
    rejected,
  );
  await assert.rejects(rejected, (error) => error === failure);
  await assert.rejects(
    service.event.serial('test/wait', 0),
    (error) => error === failure,
  );
  await assert.rejects(
    native.serial('test/wait', 0),
    (error) => error === failure,
  );
  for (const publisher of [service.event, native]) {
    await assert.rejects(publisher.parallel('test/wait', 0), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
  }
  await service.idle();
  assert.equal(
    diagnostics.length,
    0,
    "custom waiting errors remain their publisher's responsibility",
  );
  await service.dispose();
  await native.fiber.dispose();
});

test('emit preserves synchronous truncation and tracks earlier asynchronous rejection', async () => {
  const { service, diagnostics, add } = fixture();
  const hold = deferred();
  const order: string[] = [];
  const scope = add('a', (event) => {
    event.on('rsi/experiment-started', async () => {
      order.push('a');
      await hold.promise;
      throw new Error('asynchronous');
    });
  });
  add('b', (event) => {
    event.on('rsi/experiment-started', () => {
      order.push('b');
      throw new Error('synchronous');
    });
  });
  add('c', (event) => {
    event.on('rsi/experiment-started', () => {
      order.push('c');
    });
  });
  assert.throws(
    () =>
      service.event.emit('rsi/experiment-started', {
        experimentId: 'experiment',
        recipeId: 'recipe',
        policyId: 'policy',
        resumed: false,
      }),
    /synchronous/,
  );
  assert.deepEqual(order, ['a', 'b']);
  assert.ok(service.pending > 0);
  service.deactivate(scope);
  let idle = false;
  const completed = service.idle(scope).then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);
  hold.resolve();
  await completed;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.bindingId, 'a');
  assert.equal(diagnostics[0]!.eventName, 'rsi/experiment-started');
  assert.match(String(diagnostics[0]!.error), /asynchronous/);
  await service.dispose();
});

test('replacement retains waiting old callbacks and registration order for new dispatches', async () => {
  const { service, add } = fixture();
  const hold = deferred();
  const entered = deferred();
  const calls: string[] = [];
  add('a', (event) => {
    event.on('test/wait', async () => {
      entered.resolve();
      await hold.promise;
      calls.push('a');
      return undefined;
    });
  });
  const old = add('b', (event) => {
    event.on('test/wait', async () => {
      calls.push('old-b');
      return undefined;
    });
  });
  add('c', (event) => {
    event.on('test/wait', async () => {
      calls.push('c');
      return undefined;
    });
  });
  const dispatch = service.event.serial('test/wait', 0);
  await entered.promise;
  const next = add('b', (event) => {
    event.on('test/wait', async () => {
      calls.push('new-b');
      return undefined;
    });
  });
  assert.equal(old.active, false);
  assert.equal(next.active, true);
  let oldIdle = false;
  const oldCompletion = service.idle(old).then(() => {
    oldIdle = true;
  });
  assert.throws(() => service.release(old), /still in use/);
  await Promise.resolve();
  assert.equal(oldIdle, false);
  hold.resolve();
  await dispatch;
  await oldCompletion;
  assert.deepEqual(calls, ['a', 'old-b', 'c']);
  calls.length = 0;
  await service.event.serial('test/wait', 1);
  assert.deepEqual(calls, ['a', 'new-b', 'c']);
  service.release(old);
  service.deactivate(next);
  service.release(next);
  add('b', (event) => {
    event.on('test/wait', async () => {
      calls.push('latest-b');
      return undefined;
    });
  });
  calls.length = 0;
  await service.event.serial('test/wait', 2);
  assert.deepEqual(calls, ['a', 'latest-b', 'c']);
  await service.dispose();
});

test('independent experiment channels, contexts and cooperative stop preserve admitted work', async () => {
  const first = fixture();
  const second = fixture();
  const hold = deferred();
  let count = 0;
  const scope = first.add('observer', (event) => {
    event.on('test/notice', async (_event0, context) => {
      await hold.promise;
      assert.equal(context.bindingId, 'observer');
      assert.equal(context.signal.aborted, true);
      count++;
    });
  });
  second.add('observer', (event) => {
    event.on('test/notice', () => {
      count += 100;
    });
  });
  first.service.event.emit('test/notice', 1);
  first.service.event.emit('test/notice', 2);
  assert.notEqual(first.contexts[0]!.callId, first.contexts[1]!.callId);
  assert.equal(first.contexts[0]!.scope, undefined);
  first.service.stop();
  assert.throws(
    () => first.service.event.emit('test/notice', 3),
    /admission is closed/,
  );
  first.service.abort(scope, new Error('cleanup deadline'));
  hold.resolve();
  await first.service.idle();
  assert.equal(count, 2);
  await first.service.dispose();
  await second.service.dispose();
});

test('registry rejects definition listeners and keeps validation without creating instances', async () => {
  const registry = new Registry();
  let created = 0;
  const original: Operation = {
    async execute(input) {
      return input;
    },
    async dispose() {},
  };
  const definition = {
    id: 'test.events',
    contract: defineContract({
      id: 'contract.test-events',
      input_schema: true,
      output_schema: true,
    }),
    configSchema: true,
    create: async () => {
      created++;
      return original;
    },
  };
  registry.registerOperation(definition);
  assert.equal(created, 0);
  const operation = await registry
    .get(definition.id)
    .create({}, new RuntimeContext());
  assert.notEqual(operation, original);
  assert.equal(created, 1);
  assert.throws(
    () =>
      registry.registerOperation(
        Object.assign({}, definition, { id: 'invalid', listeners: [] }),
      ),
    /unknown field listeners/,
  );
  assert.throws(
    () =>
      registry.registerOperation(
        Object.assign({}, definition, {
          id: 'invalid',
          listeners: { 'test/notice': 4 },
        }),
      ),
    /unknown field listeners/,
  );
  await operation.dispose();
  await registry.dispose();
});
