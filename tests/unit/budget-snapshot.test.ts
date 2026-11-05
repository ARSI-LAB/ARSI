import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  RuntimeContext,
  defineContract,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import { applicationContract } from '../../src/contracts/plugin-types/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { compilePolicy } from '../../src/runtime/compiler/index.js';
import { executePolicy } from '../../src/runtime/policy/index.js';
import { object } from '../../src/shared/json.js';

test('Manager budget reads reflect charges without changing usage or facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-budget-snapshot-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  registry.registerOperation({
    id: 'test.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, context) {
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await context.recordCandidate(
              await context.artifacts.putJson({ kind: 'file-tree', files: [] }),
              null,
            ),
          };
        },
        async dispose() {},
      };
    },
  });
  const contract = defineContract({
    id: 'contract.test-budget',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  registry.registerOperation({
    id: 'test.budget',
    contract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, context) {
          const before = await context.facts.read(
            'budgets',
            context.experimentId,
          );
          const first = await context.readBudget();
          const again = await context.readBudget();
          assert.deepEqual(
            await context.facts.read('budgets', context.experimentId),
            before,
          );
          assert.deepEqual(again.used, first.used);
          await context.charge('modelCalls', 1);
          await context.charge('evaluationRuns', 2);
          const after = await context.readBudget();
          first.used.operations = 999;
          assert.equal(
            (await context.readBudget()).used.operations,
            after.used.operations,
          );
          return { first, after };
        },
        async dispose() {},
      };
    },
  });
  try {
    await writeFile(
      join(root, 'policy.yaml'),
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.budget-policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: { probe: { contract: contract.id } },
        steps: [{ id: 'probe', type: 'invoke', use: 'probe', with: {} }],
        output: '${{ steps.probe.output }}',
      }),
    );
    registry.registerPolicy('test.budget-policy', join(root, 'policy.yaml'));
    await writeFile(
      join(root, 'recipe.yaml'),
      stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'budget',
        application: { plugin: 'test.application', config: {} },
        policy: { id: 'test.budget-policy', config: {}, input: {} },
        bindings: { probe: { plugin: 'test.budget', config: {} } },
        budget: {
          operations: 4,
          modelCalls: 3,
          elapsedWallMs: 60000,
          cleanupReserveMs: 1000,
        },
      }),
    );
    const result = await manager.run(join(root, 'recipe.yaml'), {
      id: 'budget',
    });
    const after = object(object(result.output).after);
    assert.equal(object(after.used).operations, 2);
    assert.equal(object(after.used).modelCalls, 1);
    assert.equal(object(after.remaining).operations, 2);
    assert.equal(object(after.remaining).modelCalls, 2);
    assert.equal(object(after.used).evaluationRuns, 2);
    assert.equal(object(after.limits).evaluationRuns, null);
    assert.equal(object(after.remaining).evaluationRuns, null);
    assert.equal(object(after.limits).elapsedWallMs, undefined);
    assert.ok(
      Number(after.remainingWallMs) > 0 &&
        Number(after.remainingWallMs) <= 60000,
    );
    const saved = await manager.facts.read('budgets', 'budget');
    const resumed = await manager.run(join(root, 'recipe.yaml'), {
      id: 'budget',
      resume: true,
    });
    assert.deepEqual(resumed.output, result.output);
    assert.deepEqual(await manager.facts.read('budgets', 'budget'), saved);
    // Stop after a durable first call, then age the saved experiment instead
    // of sleeping: resume must retain both its charges and original clock.
    await writeFile(
      join(root, 'policy.yaml'),
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.budget-policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: { probe: { contract: contract.id } },
        steps: [
          { id: 'first', type: 'invoke', use: 'probe', with: {} },
          { id: 'second', type: 'invoke', use: 'probe', with: {} },
        ],
        output: '${{ steps.second.output }}',
      }),
    );
    const writeFact = manager.facts.write.bind(manager.facts);
    let interrupt = true;
    manager.facts.write = async (kind, id, value) => {
      await writeFact(kind, id, value);
      if (
        kind === 'checkpoints' &&
        interrupt &&
        object(value.journal)['steps/first']
      ) {
        interrupt = false;
        throw new Error('durable budget checkpoint interruption');
      }
    };
    await assert.rejects(
      manager.run(join(root, 'recipe.yaml'), { id: 'paused' }),
      /durable budget checkpoint/,
    );
    const paused = await manager.get('paused');
    await writeFact('experiments', 'paused', {
      ...paused,
      startedAt: new Date(Date.now() - 3000).toISOString(),
    });
    const continued = await manager.run(join(root, 'recipe.yaml'), {
      id: 'paused',
      resume: true,
    });
    const second = object(object(continued.output).after);
    assert.equal(object(second.used).operations, 3);
    assert.equal(object(second.used).modelCalls, 2);
    assert.equal(object(second.used).evaluationRuns, 4);
    assert.ok(
      Number(second.remainingWallMs) > 0 &&
        Number(second.remainingWallMs) <= 57000,
    );
  } finally {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function snapshot(remainingWallMs: number) {
  return {
    limits: { operations: 10, modelCalls: null, evaluationRuns: null },
    used: { operations: 1, modelCalls: 0, evaluationRuns: 0 },
    remaining: { operations: 9, modelCalls: null, evaluationRuns: null },
    remainingWallMs,
  };
}

test('Policy preserves a budget branch across interruption and refreshes the next boundary', async () => {
  const registry = new Registry();
  registry.registerContract({
    id: 'contract.test-budget-work',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  const policy = compilePolicy(
    {
      schemaVersion: 'rsi.policy/v1',
      id: 'test.budget-branch',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { work: { contract: 'contract.test-budget-work' } },
      state_schema: {
        type: 'object',
        properties: { finalRemaining: { type: 'number' } },
        required: ['finalRemaining'],
        additionalProperties: false,
      },
      state: { finalRemaining: 0 },
      steps: [
        {
          id: 'admit',
          type: 'if',
          if: '${{ budget.remainingWallMs > 500 }}',
          then: {
            steps: [
              { id: 'first', type: 'invoke', use: 'work', with: {} },
              {
                id: 'second',
                type: 'invoke',
                use: 'work',
                with: { remaining: '${{ budget.remainingWallMs }}' },
              },
            ],
          },
          else: {
            steps: [
              {
                id: 'fallback',
                type: 'invoke',
                use: 'work',
                with: { fallback: true },
              },
            ],
          },
        },
        {
          id: 'finish',
          type: 'state',
          state: { finalRemaining: '${{ budget.remainingWallMs }}' },
        },
      ],
      output: '${{ state }}',
    },
    { contracts: registry },
  );
  let remaining = 1000;
  let checkpoint: JsonObject | undefined;
  let interrupt = true;
  const received: JsonValue[] = [];
  const context = new RuntimeContext().extend({
    signal: new AbortController().signal,
    readBudget: async () => snapshot(remaining),
  });
  const options = {
    application: {},
    context,
    invoke: async (_binding: string, input: JsonValue) => {
      received.push(input);
      return {};
    },
    checkpoint: async (value: JsonObject) => {
      checkpoint = structuredClone(value);
      if (interrupt && object(value.journal)['steps/admit/then/first']) {
        interrupt = false;
        throw new Error('interrupt after first completed child');
      }
    },
  };
  try {
    await assert.rejects(
      executePolicy(policy, {}, {}, options),
      /interrupt after first/,
    );
    remaining = 100;
    const output = await executePolicy(
      policy,
      {},
      {},
      { ...options, restore: checkpoint },
    );
    assert.deepEqual(received, [{}, { remaining: 100 }]);
    assert.deepEqual(output, { finalRemaining: 100 });
  } finally {
    await registry.dispose();
  }
});

test('Policy journals loop budget conditions rather than re-evaluating completed iterations', async () => {
  const policy = compilePolicy({
    schemaVersion: 'rsi.policy/v1',
    id: 'test.budget-loop',
    input_schema: { type: 'object' },
    output_schema: { type: 'integer' },
    state_schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    },
    state: { count: 0 },
    steps: [
      {
        id: 'search',
        type: 'loop',
        maxIterations: 2,
        while: '${{ budget.remainingWallMs > 500 }}',
        steps: [
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + 1 }}' },
          },
        ],
      },
    ],
    output: '${{ state.count }}',
  });
  let remaining = 1000;
  let checkpoint: JsonObject | undefined;
  let interrupt = true;
  const options = {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
      readBudget: async () => snapshot(remaining),
    }),
    invoke: async () => null,
    checkpoint: async (value: JsonObject) => {
      checkpoint = structuredClone(value);
      if (
        interrupt &&
        object(value.journal)['steps/search/iteration-0/advance']
      ) {
        interrupt = false;
        throw new Error('interrupt after loop body');
      }
    },
  };
  await assert.rejects(
    executePolicy(policy, {}, {}, options),
    /interrupt after loop body/,
  );
  remaining = 100;
  assert.equal(
    await executePolicy(policy, {}, {}, { ...options, restore: checkpoint }),
    1,
  );
});

test('a step named while receives its own fresh observation after the loop condition', async () => {
  const policy = compilePolicy({
    schemaVersion: 'rsi.policy/v1',
    id: 'test.budget-boundary-keys',
    input_schema: { type: 'object' },
    output_schema: { type: 'number' },
    state_schema: {
      type: 'object',
      properties: { remaining: { type: 'number' } },
      required: ['remaining'],
      additionalProperties: false,
    },
    state: { remaining: 0 },
    steps: [
      {
        id: 'search',
        type: 'loop',
        maxIterations: 1,
        while: '${{ budget.remainingWallMs > 0 }}',
        steps: [
          {
            id: 'while',
            type: 'state',
            state: { remaining: '${{ budget.remainingWallMs }}' },
          },
        ],
      },
    ],
    output: '${{ state.remaining }}',
  });
  let reads = 0;
  const value = await executePolicy(
    policy,
    {},
    {},
    {
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
        readBudget: async () => snapshot(++reads <= 3 ? 1000 : 100),
      }),
      invoke: async () => null,
      checkpoint: async () => {},
    },
  );
  assert.equal(value, 100);
});

test('Policy validates explicit nullable state aliases without inferred schemas', async () => {
  const policy = compilePolicy({
    schemaVersion: 'rsi.policy/v1',
    id: 'test.state-alias-schema',
    input_schema: { type: 'object' },
    output_schema: { type: ['string', 'null'] },
    state_schema: {
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: { type: ['string', 'null'] },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    state: { a: null, b: null },
    steps: [
      { id: 'first', type: 'state', state: { a: 'changed' } },
      { id: 'second', type: 'state', state: { b: '${{ state.a }}' } },
      { id: 'third', type: 'state', state: { a: '${{ state.b }}' } },
    ],
    output: '${{ state.a }}',
  });
  assert.equal(
    await policy.execute({
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      invoke: async () => null,
      checkpoint: async () => {},
    }),
    'changed',
  );
});
