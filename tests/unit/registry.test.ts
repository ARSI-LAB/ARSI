import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  RuntimeContext,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

function definition(label: string): OperationDefinition {
  return {
    id: 'registry.worker',
    implementationDigest: label,
    contract: defineContract({
      id: 'contract.registry-worker',
      input_schema: { type: 'string' },
      output_schema: { type: 'string' },
    }),
    configSchema: {
      type: 'object',
      properties: { suffix: { type: 'string', default: 'default' } },
      required: ['suffix'],
      additionalProperties: false,
    },
    async create(config) {
      return {
        execute: async () => `${label}:${config.suffix}`,
        async dispose() {},
      };
    },
  };
}

test('managed factories belong to the Registry even when plugin IDs coincide', async (t) => {
  const first = new Registry();
  const second = new Registry();
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  first.registerOperation(definition('first'));
  second.registerOperation(definition('second'));
  const context = new RuntimeContext();
  for (const [registry, expected] of [
    [first, 'first:default'],
    [second, 'second:default'],
  ] as const) {
    const operation = await registry.createManagedOperation(
      'registry.worker',
      {},
      context,
    );
    try {
      assert.equal(await operation.execute('input', context), expected);
    } finally {
      await operation.dispose();
    }
  }
});

test('managed creation rejects unknown and unregistered plugins', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const context = new RuntimeContext();
  await assert.rejects(
    async () => registry.createManagedOperation('unknown', {}, context),
    /Unknown plugin unknown/,
  );
  const unregister = registry.registerOperation(definition('worker'));
  unregister();
  await assert.rejects(
    async () => registry.createManagedOperation('registry.worker', {}, context),
    /Unknown plugin registry.worker/,
  );
});

test('doctor is an optional function capability and registration never invokes it', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  for (const capability of ['doctor', 'staticDoctor']) {
    const invalid = definition('invalid');
    Object.defineProperty(invalid, capability, { value: true });
    assert.throws(
      () => registry.registerOperation(invalid),
      new RegExp(capability + ' must be a function'),
    );
  }
  assert.deepEqual(registry.catalog().plugins, []);
  let calls = 0;
  const worker = definition('worker');
  registry.registerOperation({
    ...worker,
    async doctor() {
      calls++;
      return { checks: [] };
    },
    async staticDoctor() {
      calls++;
      return { checks: [] };
    },
  });
  assert.equal(typeof registry.get(worker.id).doctor, 'function');
  assert.equal(typeof registry.get(worker.id).staticDoctor, 'function');
  const context = new RuntimeContext();
  const operation = await registry.get(worker.id).create({}, context);
  try {
    assert.equal(await operation.execute('input', context), 'worker:default');
    assert.equal(calls, 0);
  } finally {
    await operation.dispose();
  }
});

test('managed configuration is validated before factory effects', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  let creations = 0;
  const worker = definition('worker');
  registry.registerOperation({
    ...worker,
    async create(config, context) {
      creations++;
      return worker.create(config, context);
    },
  });
  await assert.rejects(
    async () =>
      registry.createManagedOperation(
        worker.id,
        { suffix: 42 },
        new RuntimeContext(),
      ),
    /plugin config.*suffix/,
  );
  assert.equal(creations, 0);
});

test('standalone creation fills configuration defaults and forwards disposal', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const worker = definition('worker');
  let disposals = 0;
  registry.registerOperation({
    ...worker,
    async create(config, context) {
      const operation = await worker.create(config, context);
      return {
        execute: operation.execute,
        async dispose() {
          disposals++;
        },
      };
    },
  });
  const context = new RuntimeContext();
  const operation = await registry.get(worker.id).create({}, context);
  assert.equal(await operation.execute('input', context), 'worker:default');
  await operation.dispose();
  assert.equal(disposals, 1);
});

test('standalone execution rejects invalid input before effects and invalid output after effects', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  let executions = 0;
  const worker = definition('worker');
  registry.registerOperation({
    ...worker,
    async create() {
      return {
        async execute() {
          executions++;
          return 42;
        },
        async dispose() {},
      };
    },
  });
  const context = new RuntimeContext();
  const operation = await registry.get(worker.id).create({}, context);
  t.after(() => operation.dispose());
  await assert.rejects(operation.execute(42, context), /plugin input/);
  assert.equal(executions, 0);
  await assert.rejects(operation.execute('input', context), /plugin output/);
  assert.equal(executions, 1);
});

test('unregister and late Cordis teardown preserve a replacement registration', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const worker = definition('original');
  const unregister = registry.registerOperation(worker);
  const fibers = [...registry.context.registry.values()].flatMap((runtime) => [
    ...runtime.fibers,
  ]);
  await Promise.all(fibers.map((fiber) => fiber.await()));
  const originalIdentity = registry.identity(worker.id);
  const release = registry.retain(worker.id);
  assert.throws(unregister, /still in use/);
  await assert.rejects(registry.dispose(), /still in use/);
  release();
  unregister();
  registry.registerOperation(definition('replacement'));
  await Promise.all(fibers.map((fiber) => fiber.await()));
  unregister();
  assert.deepEqual(registry.catalog(), {
    plugins: [worker.id],
    policies: [],
  });
  assert.notEqual(registry.identity(worker.id), originalIdentity);
  const context = new RuntimeContext();
  const operation = await registry.createManagedOperation(
    worker.id,
    {},
    context,
  );
  try {
    assert.equal(
      await operation.execute('input', context),
      'replacement:default',
    );
  } finally {
    await operation.dispose();
  }
  await registry.dispose();
  assert.deepEqual(registry.catalog(), { plugins: [], policies: [] });
});
