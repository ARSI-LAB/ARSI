import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defineContract,
  memoryContract,
  reflectionContract,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('independent trigger counters survive a failure between Memory and Reflection on the same boundary', async (t) => {
  const order: string[] = [];
  const memory: OperationDefinition = {
    id: 'memory.test',
    contract: memoryContract,
    configSchema: {},
    create: async () => ({
      async execute(input) {
        order.push('memory');
        return {
          status: 'no-change',
          resourceRef: object(input).resourceRef!,
          changeRef: null,
          reason: 'unchanged',
        };
      },
      async dispose() {},
    }),
  };
  const reflection: OperationDefinition = {
    id: 'reflection.test',
    contract: reflectionContract,
    configSchema: {},
    create: async () => ({
      async execute() {
        order.push('reflection');
        return { status: 'no-change', proposal: null, reason: 'unchanged' };
      },
      async dispose() {},
    }),
  };
  const target: OperationDefinition = {
    id: 'test.editable',
    contract: defineContract({
      id: 'contract.editable',
      input_schema: {},
      output_schema: {},
    }),
    configSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', 'x-rsi-path': 'file' } },
    },
    create: async () => ({
      execute: async () => ({}),
      dispose: async () => {},
    }),
  };
  const fixture = await managerFixture(async () => ({}), {
    plugins: [memory, reflection, target],
    bindings: {
      editable: { plugin: target.id, config: { prompt: './guidance.md' } },
    },
    policy: {
      defaults: {
        memory: { configFile: 'memory.yaml' },
        reflection: { configFile: 'reflection.yaml' },
      },
      steps: [
        {
          id: 'train',
          type: 'loop',
          maxIterations: 4,
          steps: [{ id: 'work', type: 'invoke', use: 'driver' }],
        },
      ],
      output: {},
    },
  });
  t.after(() => fixture.dispose());
  const { manager } = fixture;
  await writeFile(
    join(manager.rootDirectory, 'guidance.md'),
    'Current guidance',
  );
  await writeFile(
    join(manager.rootDirectory, 'memory.yaml'),
    JSON.stringify({
      trigger: { every: 2 },
      implementation: { ref: memory.id },
    }),
  );
  await writeFile(
    join(manager.rootDirectory, 'reflection.yaml'),
    JSON.stringify({
      implementation: { ref: reflection.id },
    }),
  );
  const write = manager.facts.write.bind(manager.facts);
  manager.facts.write = async (collection, id, value) => {
    if (
      collection === 'evolution-runs' &&
      value.kind === 'reflection' &&
      value.status === 'started' &&
      order.includes('memory')
    )
      throw new Error('interrupted after Memory finished');
    return write(collection, id, value);
  };
  await assert.rejects(fixture.run(), /interrupted after Memory finished/);
  assert.deepEqual(order, ['reflection', 'memory']);
  manager.facts.write = write;
  await manager.run(join(manager.rootDirectory, 'recipe.yaml'), {
    id: 'test',
    resume: true,
  });
  assert.deepEqual(order, [
    'reflection',
    'memory',
    'reflection',
    'reflection',
    'memory',
    'reflection',
  ]);
  for (const kind of ['memory', 'reflection'])
    assert.equal(
      (await manager.facts.read('policy-trigger-checkpoints', 'test.' + kind))
        .hits,
      4,
    );
});

test('configured loop-end, after-step, experiment-end and loopless default select their serial boundaries', async (t) => {
  const call = { id: 'work', type: 'invoke', use: 'driver' };
  const loop = { id: 'train', type: 'loop', maxIterations: 2, steps: [call] };
  const scenarios: {
    name: string;
    trigger?: JsonObject;
    steps: JsonObject[];
    expected: string[];
  }[] = [
    {
      name: 'loop-end',
      trigger: { on: 'loop-end' },
      steps: [loop],
      expected: ['steps/train'],
    },
    {
      name: 'after-step',
      trigger: { on: 'after-step', step: 'work' },
      steps: [loop],
      expected: [
        'steps/train/iteration-0/work',
        'steps/train/iteration-1/work',
      ],
    },
    {
      name: 'experiment-end',
      trigger: { on: 'experiment-end' },
      steps: [loop],
      expected: ['steps'],
    },
    { name: 'loopless default', steps: [call], expected: ['steps'] },
  ];
  for (const { name, trigger, steps, expected } of scenarios)
    await t.test(name, async (t) => {
      const generator: OperationDefinition = {
        id: 'test.memory',
        contract: memoryContract,
        configSchema: {},
        create: async () => ({
          execute: async (input) => ({
            status: 'no-change',
            resourceRef: object(input).resourceRef!,
            changeRef: null,
            reason: 'unchanged',
          }),
          dispose: async () => {},
        }),
      };
      const f = await managerFixture(async () => ({}), {
        plugins: [generator],
        policy: {
          defaults: {
            memory: { configFile: 'memory.yaml' },
            reflection: false,
          },
          steps,
          output: {},
        },
      });
      t.after(() => f.dispose());
      await writeFile(
        join(f.manager.rootDirectory, 'memory.yaml'),
        JSON.stringify({ trigger, implementation: { ref: generator.id } }),
      );
      await f.run();
      const runs = await f.manager.facts.list('evolution-runs');
      assert.deepEqual(runs.map((r) => r.triggerPath).sort(), expected);
      assert.ok(runs.every((r) => r.status === 'no-change'));
    });
});
