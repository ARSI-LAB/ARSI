import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  defineContract,
  type RuntimeContext,
  type CallDecision,
  type OperationDefinition,
  type EventPipeline,
} from '../../src/contracts/index.js';
import { managerFixture as baseManagerFixture } from '../helpers/manager-fixture.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/manager-notice'(event: { owner: string }): void;
  }
}

const observerContract = defineContract({
  id: 'contract.test-event-observer',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
});

// These scenarios explicitly call observer bindings during Application initialization.
// Unused bindings remain lazy in the Runtime; startup here is test Policy business work.
function managerFixture(
  execute: Parameters<typeof baseManagerFixture>[0],
  options: NonNullable<Parameters<typeof baseManagerFixture>[1]> = {},
): ReturnType<typeof baseManagerFixture> {
  return baseManagerFixture(execute, {
    ...options,
    initialize: async (ctx) => {
      for (const [name, binding] of Object.entries(options.bindings ?? {})) {
        if (
          options.plugins?.some(
            (plugin) =>
              plugin.id === binding.plugin &&
              (plugin.id === 'test.observer' ||
                plugin.id === 'test.inner-observer'),
          )
        )
          await ctx.invoke(name, {});
      }
    },
  });
}

function observingDefinition(
  register: (event: EventPipeline) => void,
  create?: OperationDefinition['create'],
): OperationDefinition {
  return {
    id: 'test.observer',
    contract: observerContract,
    configSchema: { type: 'object' },
    async create(config, ctx) {
      const instance = create
        ? await create(config, ctx)
        : {
            async execute() {
              return {};
            },
            async dispose() {},
          };
      register(ctx.event);
      return instance;
    },
  };
}

function hasErrorMessage(error: unknown, message: RegExp): boolean {
  return (
    error instanceof Error &&
    (message.test(error.message) ||
      (error instanceof AggregateError &&
        error.errors.some((nested: unknown) =>
          hasErrorMessage(nested, message),
        )) ||
      hasErrorMessage(error.cause, message))
  );
}

test('Manager creates only invoked bindings, activates before admission, and isolates experiments', async () => {
  let created = 0;
  let disposed = 0;
  const observed: string[] = [];
  const admissions: string[] = [];
  const definition: OperationDefinition = {
    id: 'test.lazy-observer',
    contract: observerContract,
    configSchema: { type: 'object' },
    async create(config, factoryCtx) {
      created++;
      let calls = 0;
      factoryCtx.event.on('rsi/experiment-started', () => {
        throw new Error('Historical event replayed');
      });
      factoryCtx.event.on('rsi/before-call', async (event, next, ctx) => {
        if (event.bindingId === ctx.bindingId) admissions.push(event.bindingId);
        return next();
      });
      factoryCtx.event.on('test/manager-notice', (event, ctx) => {
        assert.equal(event.owner, config.owner);
        observed.push(event.owner + '/' + ctx.bindingId);
      });
      factoryCtx.event.emit('test/manager-notice', {
        owner: String(config.owner),
      });
      return {
        async execute() {
          return { calls: ++calls };
        },
        async dispose() {
          disposed++;
        },
      };
    },
  };
  const fixtures = await Promise.all(
    ['first', 'second'].map((owner) =>
      baseManagerFixture(
        async (ctx) => {
          ctx.event.emit('test/manager-notice', { owner });
          assert.deepEqual(await ctx.invoke('observer', { attempt: 1 }), {
            calls: 1,
          });
          assert.deepEqual(await ctx.invoke('observer', { attempt: 2 }), {
            calls: 2,
          });
          ctx.event.emit('test/manager-notice', { owner });
          return {};
        },
        {
          plugins: [definition],
          bindings: {
            observer: { plugin: definition.id, config: { owner } },
            unused: { plugin: definition.id, config: { owner } },
          },
        },
      ),
    ),
  );
  try {
    assert.equal(created, 0);
    await Promise.all(fixtures.map((f) => f.run()));
    assert.deepEqual(observed.sort(), ['first/observer', 'second/observer']);
    assert.equal(created, 2);
    assert.equal(disposed, 2);
    assert.deepEqual(admissions, [
      'observer',
      'observer',
      'observer',
      'observer',
    ]);
  } finally {
    await Promise.all(fixtures.map((f) => f.dispose()));
  }
});

test('experiment metadata retains locked recipeId and resume rejects a different Recipe path without rewriting facts', async () => {
  for (const outcome of ['succeeded', 'failed', 'startup-failed']) {
    const lifecycle: {
      phase: string;
      recipeId: string;
      experimentId: string;
    }[] = [];
    let fail = outcome !== 'succeeded';
    const fixture = await baseManagerFixture(
      async () => {
        if (fail) throw new Error('driver failed');
        return {};
      },
      {
        initialize: async (ctx) => {
          ctx.event.on('rsi/experiment-started', (info) => {
            lifecycle.push({ phase: 'started', ...info });
          });
          ctx.event.on('rsi/experiment-finished', (info) => {
            lifecycle.push({ phase: 'finished', ...info });
          });
          if (fail && outcome === 'startup-failed')
            throw new Error('initialize failed');
        },
      },
    );
    try {
      const path = join(fixture.manager.rootDirectory, 'recipe.yaml');
      const recipe = await readFile(path, 'utf8');
      const id = 'separate-experiment-id';
      const first = fixture.manager.run(path, { id });
      if (outcome === 'succeeded') await first;
      else await assert.rejects(first, /failed/);
      assert.deepEqual(
        lifecycle.map((info) => info.phase),
        outcome === 'startup-failed' ? ['finished'] : ['started', 'finished'],
      );
      for (const info of lifecycle) {
        assert.equal(info.recipeId, 'test');
        assert.equal(info.experimentId, id);
      }
      const original = await fixture.manager.get(id);
      assert.equal(original.recipeId, 'test');
      const receipts = await fixture.manager.facts.list('calls');
      const changedRecipe = recipe.replace(
        /^id: test$/m,
        'id: different-recipe',
      );
      const differentPath = join(
        fixture.manager.rootDirectory,
        'different-recipe.yaml',
      );
      await writeFile(differentPath, changedRecipe);
      await assert.rejects(
        fixture.manager.run(differentPath, { id, resume: true }),
        /recipePath differs/,
      );
      assert.deepEqual(await fixture.manager.get(id), original);
      assert.deepEqual(await fixture.manager.facts.list('calls'), receipts);
      await writeFile(path, changedRecipe);
      fail = false;
      const resumed = fixture.manager.run(path, { id, resume: true });
      if (outcome === 'succeeded')
        assert.equal((await resumed).status, 'succeeded');
      else await assert.rejects(resumed, /unconfirmed\/failed effects/);
    } finally {
      await fixture.dispose();
    }
  }
});

test('Manager consumes the final native waterfall decision after an outer listener transforms rejection', async () => {
  const decisions: string[] = [];
  const outer = observingDefinition((event) => {
    event.on('rsi/before-call', async (event, next) => {
      if (event.bindingId !== 'driver') return next();
      decisions.push((await next()).kind);
      return { kind: 'proceed' };
    });
  });
  const inner: OperationDefinition = {
    ...observingDefinition((event) => {
      event.on('rsi/before-call', async (event, next) =>
        event.bindingId === 'driver'
          ? { kind: 'reject', reason: 'inner decision' }
          : next(),
      );
    }),
    id: 'test.inner-observer',
  };
  let executions = 0;
  const fixture = await managerFixture(
    async () => {
      executions++;
      return {};
    },
    {
      plugins: [outer, inner],
      bindings: {
        outer: { plugin: outer.id, config: {} },
        inner: { plugin: inner.id, config: {} },
      },
    },
  );
  try {
    await fixture.run();
    assert.equal(executions, 1);
    assert.deepEqual(decisions, ['reject']);
    const receipt = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === 'driver',
    );
    assert.equal(receipt?.status, 'succeeded');
  } finally {
    await fixture.dispose();
  }
});

test('failed lazy creation leaves existing instances owned through terminal notification', async () => {
  let activated = 0;
  let disposed = 0;
  let executed = 0;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', () => {
        activated++;
        return undefined;
      });
      event.on('rsi/experiment-finished', () => {
        activated++;
      });
    },
    async (config) => {
      if (config.fail) throw new Error('listener preparation failed');
      return {
        async execute() {
          return {};
        },
        async dispose() {
          disposed++;
        },
      };
    },
  );
  const fixture = await managerFixture(
    async () => {
      executed++;
      return {};
    },
    {
      plugins: [definition],
      bindings: {
        first: { plugin: definition.id, config: {} },
        second: { plugin: definition.id, config: { fail: true } },
      },
    },
  );
  try {
    await assert.rejects(fixture.run(), /listener preparation failed/);
    assert.equal(activated, 1);
    assert.equal(executed, 0);
    assert.equal(disposed, 1);
    assert.ok(
      (await fixture.manager.facts.list('calls')).every(
        (call) => call.bindingId !== 'driver',
      ),
    );
  } finally {
    await fixture.dispose();
  }
});

test('Manager rejects invalid or denied final admission without executing the target', async () => {
  for (const invalid of [false, true]) {
    const definition = observingDefinition((event) => {
      if (invalid) {
        // Untyped JavaScript callers can return invalid decisions; Manager must reject them.
        Reflect.apply(event.on, event, [
          'rsi/before-call',
          async (
            info: { bindingId: string },
            next: () => Promise<CallDecision>,
          ) => (info.bindingId === 'driver' ? { kind: 'invalid' } : next()),
        ]);
      } else {
        event.on('rsi/before-call', async (info, next) =>
          info.bindingId === 'driver'
            ? { kind: 'reject', reason: 'test denied' }
            : next(),
        );
      }
    });
    let executions = 0;
    const fixture = await managerFixture(
      async () => {
        executions++;
        return {};
      },
      {
        plugins: [definition],
        bindings: { observer: { plugin: definition.id, config: {} } },
      },
    );
    try {
      await assert.rejects(
        fixture.run(),
        invalid ? /decision|CallDecision/i : /test denied/,
      );
      assert.equal(executions, 0);
      const receipts = await fixture.manager.facts.list('calls');
      assert.equal(
        receipts.find((call) => call.bindingId === 'driver')?.status,
        'failed',
      );
      assert.equal(
        (await fixture.manager.facts.read('budgets', 'test')).operations,
        3,
      );
    } finally {
      await fixture.dispose();
    }
  }
});

test('a success listener failure leaves the committed successful receipt intact', async () => {
  let failedNotifications = 0;
  const definition = observingDefinition((event) => {
    event.on('rsi/call-succeeded', (event) => {
      if (event.bindingId === 'driver')
        throw new Error('success handler failed');
    });
    event.on('rsi/call-failed', (event) => {
      if (event.bindingId === 'driver') failedNotifications++;
    });
  });
  const fixture = await managerFixture(async () => ({ persisted: true }), {
    plugins: [definition],
    bindings: { observer: { plugin: definition.id, config: {} } },
  });
  try {
    await assert.rejects(fixture.run(), (error) =>
      hasErrorMessage(error, /success handler failed/),
    );
    const receipt = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === 'driver',
    );
    assert.equal(receipt?.status, 'succeeded');
    assert.deepEqual(receipt?.output, { persisted: true });
    assert.equal(failedNotifications, 0);
    assert.equal((await fixture.manager.get('test')).status, 'failed');
  } finally {
    await fixture.dispose();
  }
});

test('terminal listeners can read records but cannot use current or retained contexts for new business calls', async () => {
  let savedContext: RuntimeContext | undefined;
  let service: RuntimeContext | undefined;
  let terminalCalls = 0;
  let terminalVerified = false;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', (_event0, context) => {
        savedContext = context;
        return undefined;
      });
      event.on('rsi/experiment-finished', async (event, context) => {
        terminalCalls++;
        assert.ok(service);
        assert.ok(savedContext);
        assert.equal(
          (await service.facts.read('experiments', event.experimentId)).status,
          'succeeded',
        );
        const before = await service.facts.list('calls');
        const budget = await service.facts.read('budgets', event.experimentId);
        for (const retained of [context, savedContext])
          await assert.rejects(
            retained.invoke('driver', { late: true }),
            /closed|terminal|finished|accept/i,
          );
        assert.deepEqual(await service.facts.list('calls'), before);
        assert.deepEqual(
          await service.facts.read('budgets', event.experimentId),
          budget,
        );
        terminalVerified = true;
      });
    },
    async (_config, services) => {
      service = services;
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  );
  const fixture = await managerFixture(async () => ({}), {
    plugins: [definition],
    bindings: { observer: { plugin: definition.id, config: {} } },
  });
  try {
    const result = await fixture.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(terminalCalls, 1);
    assert.equal(terminalVerified, true);
  } finally {
    await fixture.dispose();
  }
});

test('ordinary notifications retain asynchronous listeners through cleanup without changing committed facts', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let disposed = false;
  let progress!: () => void;
  const progressed = new Promise<void>((resolve) => {
    progress = resolve;
  });
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', async () => {
        entered();
        await waiting;
        assert.equal(disposed, false);
        throw new Error('ordinary notification rejected');
      });
    },
    async () => ({
      async execute() {
        return {};
      },
      async dispose() {
        disposed = true;
      },
    }),
  );
  const fixture = await managerFixture(
    async () => {
      progress();
      return {};
    },
    {
      plugins: [definition],
      bindings: { observer: { plugin: definition.id, config: {} } },
    },
  );
  try {
    const running = fixture.run();
    await started;
    const timeout = new AbortController();
    try {
      await Promise.race([
        progressed,
        setTimeout(2000, undefined, {
          signal: timeout.signal,
          ref: false,
        }).then(() => {
          throw new Error('emit waited for a returned Promise');
        }),
      ]);
    } finally {
      timeout.abort();
    }
    assert.equal(disposed, false);
    release();
    assert.equal((await running).status, 'succeeded');
    assert.equal(disposed, true);
  } finally {
    release();
    await fixture.dispose();
  }
});

test('cleanup deadlines retain non-cooperative listener ownership and dispose only after its eventual completion', async () => {
  for (const mode of ['emit', 'finish']) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposed!: () => void;
    const disposal = new Promise<void>((resolve) => {
      disposed = resolve;
    });
    let disposals = 0;
    let listenerSignal: AbortSignal | undefined;
    const handler = async (
      _event: unknown,
      context: RuntimeContext,
    ): Promise<void> => {
      listenerSignal = context.signal;
      await pending;
      assert.equal(disposals, 0);
    };
    const definition = observingDefinition(
      (event) => {
        if (mode === 'emit') event.on('rsi/experiment-started', handler);
        else event.on('rsi/experiment-finished', handler);
      },
      async () => ({
        async execute() {
          return {};
        },
        async dispose() {
          disposals++;
          disposed();
        },
      }),
    );
    const fixture = await managerFixture(async () => ({}), {
      plugins: [definition],
      bindings: { observer: { plugin: definition.id, config: {} } },
      budget: { cleanupReserveMs: 25 },
    });
    try {
      const [result] = await Promise.allSettled([fixture.run()]);
      if (mode === 'finish') {
        assert.equal(result.status, 'fulfilled');
        assert.equal((await fixture.manager.get('test')).status, 'succeeded');
      }
      assert.equal(
        (await fixture.manager.facts.read('cleanup', 'test')).status,
        'unconfirmed',
      );
      assert.equal(disposals, 0, 'timeout does not prove the listener stopped');
      assert.equal(listenerSignal?.aborted, true);
      release();
      await disposal;
      // The plugin has settled; the remaining receipt and lock writes can outlast
      // one short cleanup reserve under concurrent filesystem load.
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await fixture.manager.dispose();
          break;
        } catch (error) {
          if (
            !hasErrorMessage(error, /Cleanup deadline exceeded/) ||
            Date.now() >= deadline
          )
            throw error;
        }
      }
      assert.equal(disposals, 1);
    } finally {
      release();
      await fixture.dispose();
    }
  }
});

test('terminal persistence failure closes business admission and never publishes an experiment result', async () => {
  let finished = 0;
  let service: RuntimeContext | undefined;
  let savedContext: RuntimeContext | undefined;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', (_event0, context) => {
        savedContext = context;
        return undefined;
      });
      event.on('rsi/experiment-finished', () => {
        finished++;
      });
    },
    async (_config, services) => {
      service = services;
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  );
  const fixture = await managerFixture(async () => ({}), {
    plugins: [definition],
    bindings: { observer: { plugin: definition.id, config: {} } },
  });
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'experiments' && value.status !== 'running')
      throw new Error('terminal persistence unavailable');
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), /terminal persistence unavailable/);
    assert.equal(finished, 0);
    assert.ok(service);
    assert.ok(savedContext);
    const receipts = await service.facts.list('calls');
    await assert.rejects(
      savedContext.invoke('driver', { afterFailure: true }),
      /accept|closed|terminal/i,
    );
    assert.deepEqual(await service.facts.list('calls'), receipts);
  } finally {
    await fixture.dispose();
  }
});

test('resume reuses committed calls without recreating their instances or replaying notifications', async () => {
  let service: RuntimeContext | undefined;
  let stop = true;
  const resumed: boolean[] = [];
  let candidates = 0;
  let successes = 0;
  let executions = 0;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', (event) => {
        resumed.push(event.resumed);
        return undefined;
      });
      event.on('rsi/candidate-recorded', () => {
        candidates++;
      });
      event.on('rsi/call-succeeded', (event) => {
        if (event.bindingId === 'driver') successes++;
      });
    },
    async (_config, services) => {
      service = services;
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  );
  const fixture = await managerFixture(
    async () => {
      executions++;
      if (stop) {
        stop = false;
        await fixture.manager.cancel('test');
      }
      return { completed: true };
    },
    {
      plugins: [definition],
      bindings: { observer: { plugin: definition.id, config: {} } },
    },
  );
  try {
    await assert.rejects(fixture.run(), /cancelled/i);
    assert.ok(service);
    const before = { candidates, successes, executions };
    const result = await fixture.manager.run(
      join(service.rootDirectory, 'recipe.yaml'),
      { id: 'test', resume: true },
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(resumed, [false]);
    assert.deepEqual({ candidates, successes, executions }, before);
  } finally {
    await fixture.dispose();
  }
});

test('listener business calls have independent contexts, observe nested events and charge the experiment outside the source local scope', async () => {
  const local = new AbortController();
  const listenerContexts: RuntimeContext[] = [];
  let observedNested = 0;
  let service: RuntimeContext | undefined;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/call-succeeded', async (event, context) => {
        if (event.bindingId === 'nested') {
          observedNested++;
          return;
        }
        if (event.bindingId !== 'source') return;
        assert.ok(service);
        listenerContexts.push(context);
        assert.equal(context.scope, undefined);
        assert.equal(context.bindingId, 'observer');
        assert.notEqual(context.callId, event.callId);
        local.abort(new Error('source local scope ended'));
        assert.equal(
          context.signal.aborted,
          false,
          'source local cancellation does not cancel the independent listener',
        );
        await context.invoke('nested', { listener: context.callId });
      });
    },
    async (_config, services) => {
      service = services;
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  );
  const source: OperationDefinition = {
    id: 'test.event-source',
    contract: observerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  };
  let nestedContext: RuntimeContext | undefined;
  const nested: OperationDefinition = {
    ...source,
    id: 'test.event-nested',
    async create(_config, _context) {
      return {
        async execute(_input, context) {
          nestedContext = context;
          await context.charge('modelCalls', 1);
          return {};
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      await context
        .extend({
          signal: local.signal,
          scope: {
            id: 'source-local',
            signal: local.signal,
            limits: { modelCalls: 0, elapsedWallMs: 1000, evidenceBytes: 1024 },
          },
        })
        .invoke('source', {});
      return {};
    },
    {
      plugins: [definition, source, nested],
      bindings: {
        observer: { plugin: definition.id, config: {} },
        source: { plugin: source.id, config: {} },
        nested: { plugin: nested.id, config: {} },
      },
      budget: { modelCalls: 1 },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
    assert.equal(listenerContexts.length, 1);
    assert.ok(nestedContext);
    assert.equal(nestedContext.scope, undefined);
    assert.equal(observedNested, 1);
    const nestedReceipt = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === 'nested',
    );
    assert.equal(nestedReceipt?.parentCallId, listenerContexts[0].callId);
    assert.equal(nestedReceipt?.status, 'succeeded');
    const budget = await fixture.manager.facts.read('budgets', 'test');
    assert.equal(budget.modelCalls, 1);
    assert.deepEqual(budget.scopes, { 'source-local': { operations: 1 } });
  } finally {
    await fixture.dispose();
  }
});

test('a controlled business failure launched from an ordinary notification still fails the experiment', async () => {
  let service: RuntimeContext | undefined;
  const definition = observingDefinition(
    (event) => {
      event.on('rsi/experiment-started', async (_event0, context) => {
        assert.ok(service);
        await context.invoke('broken', {});
      });
    },
    async (_config, services) => {
      service = services;
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  );
  const broken: OperationDefinition = {
    id: 'test.event-broken',
    contract: observerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          throw new Error('broken listener business call');
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(async () => ({}), {
    plugins: [definition, broken],
    bindings: {
      observer: { plugin: definition.id, config: {} },
      broken: { plugin: broken.id, config: {} },
    },
  });
  try {
    await assert.rejects(fixture.run(), /broken listener business call/);
    assert.equal((await fixture.manager.get('test')).status, 'failed');
    const receipt = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === 'broken',
    );
    assert.equal(receipt?.status, 'failed');
    assert.match(String(receipt?.error), /broken listener business call/);
  } finally {
    await fixture.dispose();
  }
});

test('experiment cancellation immediately reaches active listener contexts', async () => {
  let serviceSignal: AbortSignal | undefined;
  let abortObserved = false;
  const definition = observingDefinition((event) => {
    event.on('rsi/experiment-started', async (_event0, context) => {
      serviceSignal = context.signal;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            resolve();
          },
          { once: true },
        ),
      );
    });
  });
  const fixture = await managerFixture(
    async () => {
      await fixture.manager.cancel('test');
      return {};
    },
    {
      plugins: [definition],
      bindings: { observer: { plugin: definition.id, config: {} } },
    },
  );
  try {
    await assert.rejects(fixture.run(), /cancelled/i);
    assert.equal(serviceSignal?.aborted, true);
    assert.equal(abortObserved, true);
    assert.equal((await fixture.manager.get('test')).status, 'cancelled');
  } finally {
    await fixture.dispose();
  }
});

test('unknown external effects remain unknown after local cancellation and result-listener failure', async () => {
  const local = new AbortController();
  const failure = Object.assign(new Error('external outcome unconfirmed'), {
    status: 'unknown',
  });
  let unknown = 0;
  let cancelled = 0;
  const definition = observingDefinition((event) => {
    event.on('rsi/call-unknown', (event) => {
      if (event.bindingId !== 'uncertain') return;
      unknown++;
      throw new Error('unknown result handler failed');
    });
    event.on('rsi/call-cancelled', (event) => {
      if (event.bindingId === 'uncertain') cancelled++;
    });
  });
  const uncertain: OperationDefinition = {
    id: 'test.uncertain',
    contract: observerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          local.abort(new Error('local cancellation'));
          throw failure;
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      await context
        .extend({
          signal: local.signal,
          scope: {
            id: 'uncertain-local',
            signal: local.signal,
            limits: { modelCalls: 1, elapsedWallMs: 1000, evidenceBytes: 1024 },
          },
        })
        .invoke('uncertain', {});
      return {};
    },
    {
      plugins: [definition, uncertain],
      bindings: {
        observer: { plugin: definition.id, config: {} },
        uncertain: { plugin: uncertain.id, config: {} },
      },
    },
  );
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
    const receipt = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === 'uncertain',
    );
    assert.equal(receipt?.status, 'unknown');
    assert.match(String(receipt?.error), /external outcome unconfirmed/);
    assert.equal(unknown, 1);
    assert.equal(cancelled, 0);
  } finally {
    await fixture.dispose();
  }
});

test('cancellation bounds non-cooperative preparation and admission listeners while retaining their instances', async () => {
  for (const mode of ['preparation', 'admission']) {
    const cancellation = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let dispose!: () => void;
    const disposed = new Promise<void>((resolve) => {
      dispose = resolve;
    });
    let disposals = 0;
    let executions = 0;
    let listenerSignal: AbortSignal | undefined;
    const wait = async (context: RuntimeContext): Promise<void> => {
      listenerSignal = context.signal;
      enter();
      await pending;
      assert.equal(disposals, 0);
    };
    const definition = observingDefinition(
      (event) => {
        if (mode === 'preparation')
          event.on('rsi/policy-started', async (_event, context) => {
            await wait(context);
            return undefined;
          });
        else
          event.on('rsi/before-call', async (event, next, context) => {
            if (event.bindingId !== 'driver') return next();
            await wait(context);
            return { kind: 'proceed' };
          });
      },
      async () => ({
        async execute() {
          return {};
        },
        async dispose() {
          disposals++;
          dispose();
        },
      }),
    );
    const fixture = await managerFixture(
      async () => {
        executions++;
        return {};
      },
      {
        plugins: [definition],
        bindings: { observer: { plugin: definition.id, config: {} } },
        budget: { cleanupReserveMs: 25 },
      },
    );
    try {
      const running = fixture.manager.run(
        join(fixture.manager.rootDirectory, 'recipe.yaml'),
        { id: 'test', signal: cancellation.signal },
      );
      await entered;
      cancellation.abort(new Error('stop non-cooperative listener'));
      const timeout = new AbortController();
      try {
        await assert.rejects(
          Promise.race([
            running,
            setTimeout(2000, undefined, {
              signal: timeout.signal,
              ref: false,
            }).then(() => {
              throw new Error('cancellation failed to bound the listener wait');
            }),
          ]),
          /stop non-cooperative listener/,
        );
      } finally {
        timeout.abort();
      }
      assert.equal(listenerSignal?.aborted, true);
      assert.equal((await fixture.manager.get('test')).status, 'cancelled');
      assert.equal(
        (await fixture.manager.facts.read('cleanup', 'test')).status,
        'unconfirmed',
      );
      assert.equal(disposals, 0);
      release();
      await disposed;
      // Plugin disposal precedes receipt publication and lock release; observing
      // that remaining cleanup may exceed one intentionally short reserve.
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await fixture.manager.dispose();
          break;
        } catch (error) {
          if (
            !hasErrorMessage(error, /Cleanup deadline exceeded/) ||
            Date.now() >= deadline
          )
            throw error;
        }
      }
      assert.equal(disposals, 1);
      assert.equal(executions, 0);
    } finally {
      release();
      await fixture.dispose();
    }
  }
});
