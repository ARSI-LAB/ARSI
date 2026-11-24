import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defineContract,
  RuntimeContext,
  type Binding,
  type JsonObject,
} from '../../src/contracts/index.js';
import { CleanupLifecycle } from '../../src/runtime/manager/cleanup.js';
import { Instances } from '../../src/runtime/manager/instances.js';
import { LearningActivation } from '../../src/runtime/manager/activation.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { ManagedEvents } from '../../src/runtime/services/events.js';
import { FileFacts } from '../../src/runtime/storage/index.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/activation-version'(): Promise<void>;
  }
}

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  t: TestContext,
  options: {
    create?(version: number): Promise<void>;
    listener?(version: number): Promise<void>;
    failCommit?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-activation-races-'));
  const registry = new Registry();
  const facts = new FileFacts(join(directory, 'facts'));
  const oldBinding: Binding = {
    plugin: 'activation.worker',
    config: { version: 1 },
  };
  const newBinding: Binding = { ...oldBinding, config: { version: 2 } };
  const bindings: Record<string, Binding> = { worker: oldBinding };
  const created: number[] = [];
  const disposed: number[] = [];
  const delivered: number[] = [];
  const notifications: JsonObject[] = [];
  const disposal = new Map([
    [1, gate()],
    [2, gate()],
  ]);
  const context = new RuntimeContext().extend({
    experimentId: 'activation-race',
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
    facts,
  });
  const events = new ManagedEvents({
    context: (bindingId, callId, signal) =>
      context.extend({ bindingId, callId, signal }),
    diagnostic: () => {},
  });
  registry.registerOperation({
    id: oldBinding.plugin,
    contract: defineContract({
      id: 'contract.activation-worker',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: {
      type: 'object',
      required: ['version'],
      properties: { version: { type: 'number' } },
      additionalProperties: false,
    },
    async create(config, services) {
      const version = Number(config.version);
      created.push(version);
      await options.create?.(version);
      services.event.on('test/activation-version', async () => {
        delivered.push(version);
        await options.listener?.(version);
      });
      services.event.on('rsi/revision-activated', () => {
        notifications.push({
          version,
          revisionRef: activation.revisionRefs.worker!,
          bindingVersion: activation.bindings.worker!.config.version!,
        });
      });
      return {
        execute: async () => ({ version }),
        dispose: async () => {
          disposed.push(version);
          disposal.get(version)!.release();
        },
      };
    },
  });
  const instances = new Instances(registry, events, (bindingId) =>
    context.extend({ bindingId }),
  );
  const cleanup = new CleanupLifecycle(
    context.experimentId,
    1000,
    facts,
    events,
    instances,
    async () => {},
  );
  const writing = gate();
  const commit = gate();
  const write = facts.write.bind(facts);
  facts.write = async (kind, id, value) => {
    if (kind === 'activations') {
      writing.release();
      await commit.promise;
      if (options.failCommit) throw new Error('activation commit failed');
    }
    await write(kind, id, value);
  };
  const activation = new LearningActivation({
    id: context.experimentId,
    bindings,
    facts,
    registry,
    instances,
    cleanup,
    event: events.event,
    diagnose: () => {},
  });
  t.after(async () => {
    commit.release();
    await cleanup.start(
      async () => {},
      Promise.resolve(),
      async () => {},
    );
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  activation.initialize({ worker: 'revision-old' });
  return {
    instances,
    events,
    facts,
    context,
    bindings: activation.bindings,
    revisionRefs: activation.revisionRefs,
    activation,
    oldBinding,
    writing,
    commit,
    created,
    disposed,
    delivered,
    notifications,
    restore: () => activation.restore(),
    disposedVersion: (version: number) => disposal.get(version)!.promise,
    save: () =>
      activation.saveRevisions(
        { worker: newBinding },
        { worker: 'revision-new' },
        'activation-new',
      ),
  };
}

test('restored activation publishes its binding and revision together to existing readers', async (t) => {
  const f = await fixture(t);
  f.commit.release();
  await f.facts.write('activations', 'activation-race', {
    activationId: 'activation-restored',
    bindings: {
      worker: {
        plugin: 'activation.worker',
        config: { version: 2 },
      },
    },
    revisions: { worker: 'revision-restored' },
  });
  await f.restore();
  const lease = await f.instances.acquire('worker', f.bindings.worker!);
  try {
    assert.deepEqual(await lease.operation.execute({}, f.context), {
      version: 2,
    });
    assert.equal(f.revisionRefs.worker, 'revision-restored');
    assert.deepEqual(f.notifications, []);
    assert.deepEqual(f.created, [2]);
  } finally {
    lease.release();
  }
});

test(
  'activation replaces a cold binding acquired during its durable write and retains old leases and listeners',
  { timeout: 5000 },
  async (t) => {
    const listener = gate();
    const f = await fixture(t, {
      listener: async (version) => {
        if (version === 1) await listener.promise;
      },
    });
    const saving = f.save();
    await f.writing.promise;
    const old = await f.instances.acquire('worker', f.oldBinding);
    const oldNotification = f.events.event.parallel('test/activation-version');
    try {
      f.commit.release();
      await saving;
      assert.deepEqual(f.notifications, [
        { version: 2, revisionRef: 'revision-new', bindingVersion: 2 },
      ]);
      const current = await f.instances.acquire('worker', f.bindings.worker!);
      try {
        assert.deepEqual(await current.operation.execute({}, f.context), {
          version: 2,
        });
        assert.deepEqual(await old.operation.execute({}, f.context), {
          version: 1,
        });
        assert.equal(f.revisionRefs.worker, 'revision-new');
        assert.deepEqual(f.notifications, [
          { version: 2, revisionRef: 'revision-new', bindingVersion: 2 },
        ]);
        await f.events.event.parallel('test/activation-version');
        assert.deepEqual(f.delivered, [1, 2]);
        old.release();
        assert.deepEqual(f.disposed, []);
        listener.release();
        await oldNotification;
        await f.disposedVersion(1);
        assert.deepEqual(f.disposed, [1]);
      } finally {
        current.release();
      }
      await f.instances.disposeAll();
      assert.deepEqual(f.created, [2, 1]);
      assert.deepEqual(f.disposed, [1, 2]);
    } finally {
      old.release();
      listener.release();
      f.commit.release();
      await oldNotification;
      await saving;
    }
  },
);

test(
  'activation does not wait for an old lazy factory or reinstall its listeners after it finishes',
  { timeout: 5000 },
  async (t) => {
    const factory = gate();
    const entered = gate();
    const f = await fixture(t, {
      create: async (version) => {
        if (version === 1) {
          entered.release();
          await factory.promise;
        }
      },
    });
    const saving = f.save();
    await f.writing.promise;
    const admitted = f.instances.acquire('worker', f.oldBinding);
    await entered.promise;
    let old: Awaited<typeof admitted> | undefined;
    try {
      f.commit.release();
      await saving;
      assert.deepEqual(f.notifications, [
        { version: 2, revisionRef: 'revision-new', bindingVersion: 2 },
      ]);
      const current = await f.instances.acquire('worker', f.bindings.worker!);
      try {
        assert.deepEqual(await current.operation.execute({}, f.context), {
          version: 2,
        });
        factory.release();
        old = await admitted;
        assert.deepEqual(await old.operation.execute({}, f.context), {
          version: 1,
        });
        await f.events.event.parallel('test/activation-version');
        assert.deepEqual(f.delivered, [2]);
        assert.deepEqual(f.disposed, []);
        old.release();
        await f.disposedVersion(1);
        assert.deepEqual(f.disposed, [1]);
      } finally {
        current.release();
      }
      await f.instances.disposeAll();
      assert.deepEqual(f.disposed, [1, 2]);
    } finally {
      factory.release();
      old ??= await admitted;
      old.release();
      f.commit.release();
      await saving;
    }
  },
);

test(
  'an old lazy factory failure cannot fail or replace an already committed activation',
  { timeout: 5000 },
  async (t) => {
    const factory = gate();
    const entered = gate();
    const f = await fixture(t, {
      create: async (version) => {
        if (version === 1) {
          entered.release();
          await factory.promise;
          throw new Error('old factory failed');
        }
      },
    });
    const saving = f.save();
    await f.writing.promise;
    const admitted = assert.rejects(
      f.instances.acquire('worker', f.oldBinding),
      /old factory failed/,
    );
    await entered.promise;
    try {
      f.commit.release();
      await saving;
      factory.release();
      await admitted;
      const current = await f.instances.acquire('worker', f.bindings.worker!);
      try {
        assert.deepEqual(await current.operation.execute({}, f.context), {
          version: 2,
        });
        assert.equal(f.revisionRefs.worker, 'revision-new');
        await f.events.event.parallel('test/activation-version');
        assert.deepEqual(f.delivered, [2]);
      } finally {
        current.release();
      }
      await f.instances.disposeAll();
      assert.deepEqual(f.disposed, [2]);
    } finally {
      factory.release();
      f.commit.release();
      await admitted;
      await saving;
    }
  },
);

for (const failure of ['prepare', 'commit'] as const) {
  test(`failed cold-target activation ${failure} leaves the old binding and revision live`, async (t) => {
    const f = await fixture(t, {
      create: async (version) => {
        if (failure === 'prepare' && version === 2)
          throw new Error('activation prepare failed');
      },
      failCommit: failure === 'commit',
    });
    f.commit.release();
    await assert.rejects(f.save(), /activation (prepare|commit) failed/);
    assert.deepEqual(f.bindings.worker, f.oldBinding);
    assert.equal(f.revisionRefs.worker, 'revision-old');
    assert.deepEqual(f.notifications, []);
    await assert.rejects(f.facts.read('activations', 'activation-race'), {
      code: 'ENOENT',
    });
    const current = await f.instances.acquire('worker', f.bindings.worker!);
    try {
      assert.deepEqual(await current.operation.execute({}, f.context), {
        version: 1,
      });
      await f.events.event.parallel('test/activation-version');
      assert.deepEqual(f.delivered, [1]);
    } finally {
      current.release();
    }
    assert.deepEqual(f.created, [2, 1]);
    if (failure === 'commit') await f.disposedVersion(2);
    await f.instances.disposeAll();
    assert.deepEqual(
      [...f.disposed].sort(),
      failure === 'commit' ? [1, 2] : [1],
    );
  });
}

test('initializing and restoring Memory are silent; a learned version notifies listeners after activation', async (t) => {
  const f = await fixture(t);
  const observer = f.events.prepare('observer');
  const notifications: string[] = [];
  observer.event.on('rsi/memory-activated', (event) => {
    notifications.push(event.memoryVersionRef);
  });
  f.events.activate(observer);
  f.commit.release();
  const seed = { ref: 'seed', rootRef: 'seed', artifactRef: 'artifact:seed' };
  await f.activation.initializeMemory(seed);
  assert.deepEqual(f.activation.memory, seed);
  assert.deepEqual(
    (await f.facts.read('activations', 'activation-race')).memory,
    seed,
  );
  await f.restore();
  assert.deepEqual(notifications, []);

  const learned = { ...seed, ref: 'learned', artifactRef: 'artifact:learned' };
  await f.activation.saveMemory(learned, 'learning-update');
  await f.restore();
  assert.deepEqual(f.activation.memory, learned);
  assert.deepEqual(notifications, [learned.ref]);
});

test('simultaneous Memory and revision saves preserve both active pointers without restarting Memory consumers', async (t) => {
  const f = await fixture(t);
  const lease = await f.instances.acquire('worker', f.bindings.worker!);
  try {
    const memory = {
      ref: 'memory-first',
      artifactRef: 'artifact:immutable',
      rootRef: 'memory-first',
    };
    const saving = f.activation.saveMemory(memory, 'learning-memory-first');
    await f.writing.promise;
    assert.equal(f.activation.memory, null);
    const revising = f.save();
    f.commit.release();
    await Promise.all([saving, revising]);
    assert.deepEqual(f.created, [1, 2]);
    const saved = await f.facts.read('activations', 'activation-race');
    assert.deepEqual(saved.memory, memory);
    assert.deepEqual(saved.revisions, { worker: 'revision-new' });
  } finally {
    lease.release();
  }
});

test('a lost acknowledgement after durable activation publishes both pointers to live readers', async (t) => {
  const f = await fixture(t);
  f.commit.release();
  const write = f.facts.write.bind(f.facts);
  f.facts.write = async (kind, id, data) => {
    await write(kind, id, data);
    if (kind === 'activations') throw new Error('lost acknowledgement');
  };
  const memory = {
    ref: 'memory-first',
    artifactRef: 'artifact:immutable',
    rootRef: 'memory-first',
  };
  await f.activation.saveMemory(memory, 'learning-memory-first');
  await f.save();
  assert.equal(f.activation.memory?.ref, memory.ref);
  assert.equal(f.activation.revisionRefs.worker, 'revision-new');
  assert.equal(f.activation.bindings.worker!.config.version, 2);
  assert.deepEqual(
    (await f.facts.read('activations', 'activation-race')).memory,
    memory,
  );
});
