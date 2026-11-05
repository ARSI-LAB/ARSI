import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type Binding,
  type EventPipeline,
  RuntimeContext,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { defineContract } from '../../src/contracts/index.js';
import { createCallExecutor } from '../../src/runtime/manager/calls.js';
import { Instances } from '../../src/runtime/manager/instances.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { ManagedEvents } from '../../src/runtime/services/events.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/instance-notification'(): void;
  }
}

const contract = defineContract({
  id: 'contract.instance-test',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
});

async function fixture(t: TestContext, definition: OperationDefinition) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-instances-'));
  const registry = new Registry();
  registry.registerOperation(definition);
  const context = (bindingId: string, callId: string): RuntimeContext =>
    new RuntimeContext().extend({
      experimentId: 'exp-instance',
      bindingId,
      callId,
      idempotencyKey: callId,
      directory: join(directory, callId),
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    });
  const events = new ManagedEvents({
    context: (bindingId, listenerId, signal) =>
      context(bindingId, listenerId).extend({
        signal,
      }),
    diagnostic: () => {},
  });
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const facts = new FileFacts(join(directory, 'facts'));
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected plugin service use');
  };
  const services: RuntimeContext = new RuntimeContext().extend({
    event: events.event,
    rootDirectory: directory,
    dataDirectory: directory,
    artifacts,
    facts,
    workspaces: new FileWorkspaces(join(directory, 'workspaces'), artifacts),
    readCandidate: unavailable,
    recordCandidate: unavailable,
    recordMeasurement: unavailable,
    readMeasurement: unavailable,
    application: unavailable,
    applicationMetadata: unavailable,
    invokeAgent: unavailable,
    readEvidence: unavailable,
    invoke: unavailable,
    charge: unavailable,
    withInstance: unavailable,
  });
  const instances = new Instances(registry, events, () => services);
  t.after(async () => {
    await instances.disposeAll();
    await events.dispose();
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { instances, events, registry, facts, context };
}

test('failed creation revokes staged subscriptions and closes the factory context', async (t) => {
  let event!: EventPipeline;
  let deliveries = 0;
  let remove!: () => boolean;
  const definition: OperationDefinition = {
    id: 'instance.failed',
    contract,
    configSchema: { type: 'object' },
    async create(_config, ctx) {
      event = ctx.event;
      remove = event.on('test/instance-notification', () => {
        deliveries++;
      });
      event.emit('test/instance-notification');
      throw new Error('factory failed');
    },
  };
  const { instances, events } = await fixture(t, definition);
  await assert.rejects(
    instances.acquire('worker', { plugin: definition.id, config: {} }),
    /factory failed/,
  );
  events.event.emit('test/instance-notification');
  assert.equal(deliveries, 0);
  assert.equal(remove(), false);
  assert.throws(
    () => event.on('test/instance-notification', () => {}),
    /scope is closed/,
  );
});

test('shutdown during shared lazy creation disposes the late instance without activating subscriptions', async (t) => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creations = 0;
  let disposals = 0;
  let notifications = 0;
  const definition: OperationDefinition = {
    id: 'instance.pending',
    contract,
    configSchema: { type: 'object' },
    async create(_config, ctx) {
      creations++;
      ctx.event.on('test/instance-notification', () => {
        notifications++;
      });
      enter();
      await gate;
      return {
        async execute() {
          return {};
        },
        async dispose() {
          disposals++;
        },
      };
    },
  };
  const { instances, events } = await fixture(t, definition);
  t.after(() => release());
  const binding = { plugin: definition.id, config: {} };
  const first = instances.acquire('worker', binding);
  const second = instances.acquire('worker', binding);
  const results = Promise.all([
    assert.rejects(first, /admission is closed/),
    assert.rejects(second, /admission is closed/),
  ]);
  await entered;
  events.event.emit('test/instance-notification');
  events.stop();
  const cleanup = instances.disposeAll();
  assert.equal(disposals, 0);
  release();
  await results;
  await cleanup;
  assert.equal(creations, 1);
  assert.equal(disposals, 1);
  assert.equal(notifications, 0);
});

test('an acquire reserves the old instance before its first await during replacement', async (t) => {
  const disposed: number[] = [];
  const definition: OperationDefinition = {
    id: 'instance.versioned',
    contract,
    configSchema: { type: 'object' },
    async create(config) {
      const version = Number(config.version);
      return {
        execute: async () => ({ version }),
        dispose: async () => {
          disposed.push(version);
        },
      };
    },
  };
  const { instances, context } = await fixture(t, definition);
  const binding = { plugin: definition.id, config: { version: 1 } };
  const old = await instances.prepare('worker', binding);
  const replacement = await instances.prepare('worker', {
    ...binding,
    config: { version: 2 },
  });
  instances.activate('worker', old);
  const acquiring = instances.acquire('worker', binding);
  instances.activate('worker', replacement);
  const retirement = instances.dispose(old);
  await Promise.resolve();
  const disposedBeforeAcquisition = [...disposed];
  const lease = await acquiring;
  let originalResult;
  try {
    originalResult = await lease.operation.execute(
      {},
      context('worker', 'old'),
    );
  } finally {
    lease.release();
  }
  await retirement;
  assert.deepEqual(disposedBeforeAcquisition, []);
  assert.deepEqual(originalResult, { version: 1 });
  assert.deepEqual(disposed, [1]);
  const next = await instances.acquire('worker', binding);
  try {
    assert.deepEqual(
      await next.operation.execute({}, context('worker', 'new')),
      {
        version: 2,
      },
    );
  } finally {
    next.release();
  }
});

test('retirement retains an aborted listener until settlement and disposes its instance once', async (t) => {
  let releaseListener!: () => void;
  let releaseDisposal!: () => void;
  const listenerGate = new Promise<void>((resolve) => {
    releaseListener = resolve;
  });
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let listenerSignal: AbortSignal | undefined;
  let disposals = 0;
  const definition: OperationDefinition = {
    id: 'instance.listener',
    contract,
    configSchema: { type: 'object' },
    async create(_config, ctx) {
      ctx.event.on('test/instance-notification', (context) => {
        listenerSignal = context.signal;
        return listenerGate;
      });
      return {
        execute: async () => ({}),
        async dispose() {
          disposals++;
          await disposalGate;
        },
      };
    },
  };
  t.after(() => {
    releaseListener();
    releaseDisposal();
  });
  const { instances, events } = await fixture(t, definition);
  const instance = await instances.prepare('worker', {
    plugin: definition.id,
    config: {},
  });
  instances.activate('worker', instance);
  events.event.emit('test/instance-notification');
  const retirement = instances.dispose(instance);
  assert.equal(instances.dispose(instance), retirement);
  events.abort(instance.scope, new Error('cleanup deadline exceeded'));
  await Promise.resolve();
  assert.equal(listenerSignal?.aborted, true);
  assert.equal(disposals, 0);
  releaseListener();
  await events.idle(instance.scope);
  await Promise.resolve();
  assert.equal(disposals, 1);
  const all = instances.disposeAll();
  await Promise.resolve();
  assert.equal(disposals, 1);
  releaseDisposal();
  await Promise.all([retirement, all]);
  assert.equal(disposals, 1);
});

test('a call uses the revision and instance pinned before admission even if the binding switches', async (t) => {
  let entered!: () => void;
  let continueAdmission!: () => void;
  const admissionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const admissionGate = new Promise<void>((resolve) => {
    continueAdmission = resolve;
  });
  const disposed: number[] = [];
  const definition: OperationDefinition = {
    id: 'instance.call-versioned',
    contract,
    configSchema: { type: 'object' },
    async create(config, ctx) {
      const version = Number(config.version);
      ctx.event.on('rsi/before-call', async (event, next) => {
        if (event.path === 'first') {
          assert.equal(event.revisionRef, 'revision-old');
          entered();
          await admissionGate;
        }
        return next();
      });
      return {
        execute: async () => ({ version }),
        dispose: async () => {
          disposed.push(version);
        },
      };
    },
  };
  t.after(() => continueAdmission());
  const { instances, registry, facts, context } = await fixture(t, definition);
  let binding: Binding = { plugin: definition.id, config: { version: 1 } };
  const original = await instances.prepare('worker', binding);
  const replacement = await instances.prepare('worker', {
    ...binding,
    config: { version: 2 },
  });
  instances.activate('worker', original);
  const revisionRefs = { worker: 'revision-old' };
  const invoke = createCallExecutor({
    id: 'exp-instance',
    registry,
    facts,
    revisionRefs,
    context,
    binding: () => binding,
    operation: (bindingId, activeBinding) =>
      instances.acquire(bindingId, activeBinding),
    charge: async () => {},
    diagnose: () => {},
    onFailure: () => {},
  });
  const first = invoke('worker', {}, context('_root', 'root'), 'first');
  await admissionEntered;
  binding = { plugin: definition.id, config: { version: 2 } };
  revisionRefs.worker = 'revision-new';
  instances.activate('worker', replacement);
  const retirement = instances.dispose(original);
  assert.deepEqual(disposed, []);
  continueAdmission();
  assert.deepEqual(await first, { version: 1 });
  await retirement;
  assert.deepEqual(disposed, [1]);
  assert.deepEqual(
    await invoke('worker', {}, context('_root', 'root'), 'second'),
    {
      version: 2,
    },
  );
  const receipts = await facts.list('calls');
  const firstReceipt = receipts.find((receipt) => receipt.path === 'first')!;
  const nextReceipt = receipts.find((receipt) => receipt.path === 'second')!;
  assert.equal(firstReceipt.revisionRef, 'revision-old');
  assert.deepEqual(firstReceipt.output, { version: 1 });
  assert.equal(nextReceipt.revisionRef, 'revision-new');
  assert.deepEqual(nextReceipt.output, { version: 2 });
});
