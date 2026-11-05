import { RuntimeContext } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy } from '../../src/runtime/compiler/index.js';
import type { JsonObject, JsonValue } from '../../src/contracts/index.js';

const base = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.test',
  input_schema: { type: 'object' },
  output_schema: true,
  state_schema: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    additionalProperties: false,
  },
  state: { count: 0 },
  steps: [],
  output: '${{ state.count }}',
};
function options() {
  return {
    input: {},
    config: {},
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    invoke: async (): Promise<JsonValue> => null,
    checkpoint: async (_value: JsonObject) => {},
  };
}
test('explicit state, independent execution, lazy input defaults and loop output use the outer scope', async () => {
  const policy = compilePolicy({
    ...base,
    input_schema: { type: 'object', required: ['value'] },
    input: { value: '${{ application.missing }}' },
    steps: [
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 3,
        steps: [
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + 1 }}' },
          },
        ],
        output: '${{ state.count }}',
      },
    ],
    output: '${{ steps.repeat.output }}',
  });
  assert.equal(await policy.execute({ ...options(), input: { value: 1 } }), 3);
  assert.equal(await policy.execute({ ...options(), input: { value: 2 } }), 3);
});
test('journal recovery skips completed containers and replays control at the nearest loop', async () => {
  const policy = compilePolicy({
    ...base,
    steps: [
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 3,
        steps: [
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + 1 }}' },
          },
          {
            id: 'choose',
            type: 'if',
            if: '${{ state.count == 2 }}',
            then: {
              steps: [{ id: 'stop', type: 'control', control: 'break' }],
            },
          },
        ],
      },
      {
        id: 'after',
        type: 'state',
        state: { count: '${{ state.count + 10 }}' },
      },
    ],
  });
  let snapshot: JsonObject = {};
  let interrupted = false;
  const runOptions = {
    ...options(),
    checkpoint: async (value: JsonObject) => {
      snapshot = value;
      if (
        !interrupted &&
        JSON.stringify(value.journal).includes('"kind":"break"')
      ) {
        interrupted = true;
        throw new Error('durable interruption');
      }
    },
  };
  await assert.rejects(policy.execute(runOptions), /durable interruption/);
  assert.equal(await policy.execute({ ...runOptions, restore: snapshot }), 12);
  assert.equal(await policy.execute({ ...runOptions, restore: snapshot }), 12);
  await assert.rejects(
    policy.execute({ ...runOptions, restore: {} }),
    /checkpoint.*format/i,
  );
  await assert.rejects(
    policy.execute({
      ...runOptions,
      input: { changed: true },
      restore: snapshot,
    }),
    /identity/,
  );
});
test('dynamic parallel checks happen before dispatch and serial foreach can update state', async () => {
  const policy = compilePolicy({
    ...base,
    config_schema: {
      type: 'object',
      properties: { concurrency: { type: 'integer' } },
    },
    steps: [
      {
        id: 'each',
        type: 'foreach',
        foreach: [1, 2],
        as: 'item',
        key: '${{ item }}',
        concurrency: '${{ config.concurrency }}',
        steps: [
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + item }}' },
          },
        ],
        output: '${{ state.count }}',
      },
    ],
    output: '${{ steps.each.output }}',
  });
  assert.deepEqual(
    await policy.execute({ ...options(), config: { concurrency: 1 } }),
    [1, 3],
  );
  let checkpoints = 0;
  await assert.rejects(
    policy.execute({
      ...options(),
      config: { concurrency: 2 },
      checkpoint: async () => {
        checkpoints++;
      },
    }),
    /parallel/,
  );
  assert.equal(checkpoints, 0);
});
test('foreach preflights canonical keys and preserves source order', async () => {
  const definition = {
    ...base,
    steps: [
      {
        id: 'each',
        type: 'foreach',
        foreach: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
        as: 'item',
        key: '${{ item }}',
        steps: [],
        output: '${{ item }}',
      },
    ],
    output: '${{ steps.each.output }}',
  };
  await assert.rejects(
    compilePolicy(definition).execute(options()),
    /duplicate foreach key/,
  );
  assert.deepEqual(
    await compilePolicy({
      ...definition,
      steps: [{ ...definition.steps[0], foreach: [3, 1, 2], concurrency: 3 }],
    }).execute(options()),
    [3, 1, 2],
  );
});
test('state updates commit normalized defaults and invocation payloads have independent ownership', async () => {
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = compilePolicy(
    {
      ...base,
      state_schema: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            properties: { injected: { type: 'integer', default: 2 } },
          },
        },
        additionalProperties: false,
      },
      state: { payload: { injected: 1 } },
      require: { work: { contract: contract.id } },
      steps: [
        { id: 'update', type: 'state', state: { payload: {} } },
        {
          id: 'call',
          type: 'invoke',
          use: 'work',
          with: '${{ state.payload }}',
        },
      ],
      output: { patch: '${{ steps.update.output }}', state: '${{ state }}' },
    },
    { contracts: { contract: () => contract } },
  );
  const result = await policy.execute({
    ...options(),
    invoke: async (_name, value) => {
      assert.deepEqual(value, { injected: 2 });
      (value as JsonObject).injected = 99;
      return null;
    },
  });
  assert.deepEqual(result, {
    patch: { payload: { injected: 2 } },
    state: { payload: { injected: 2 } },
  });
});
test('zero loops skip their condition and empty blocks return explicit null outputs', async () => {
  const policy = compilePolicy({
    ...base,
    steps: [
      {
        id: 'zero',
        type: 'loop',
        maxIterations: 0,
        while: '${{ input.unavailable }}',
        steps: [],
        output: '${{ state.count }}',
      },
      {
        id: 'branch',
        type: 'if',
        if: false,
        then: { steps: [], output: '${{ input.unavailable }}' },
      },
      {
        id: 'each',
        type: 'foreach',
        foreach: [1, 2],
        as: 'item',
        key: '${{ item }}',
        steps: [],
      },
    ],
    output: {
      zero: '${{ steps.zero.output }}',
      branch: '${{ steps.branch.output }}',
      each: '${{ steps.each.output }}',
    },
  });
  assert.deepEqual(await policy.execute(options()), {
    zero: 0,
    branch: null,
    each: [null, null],
  });
});
test('continue propagates through if, skips unfinished output and resets each iteration scope', async () => {
  const policy = compilePolicy({
    ...base,
    steps: [
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 3,
        while: '${{ state.count < 10 }}',
        steps: [
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + 1 }}' },
          },
          {
            id: 'branch',
            type: 'if',
            if: '${{ loop.index < 2 }}',
            then: {
              steps: [{ id: 'next', type: 'control', control: 'continue' }],
              output: '${{ input.unavailable }}',
            },
          },
          {
            id: 'after',
            type: 'state',
            state: { count: '${{ state.count + 10 }}' },
          },
        ],
      },
    ],
  });
  assert.equal(await policy.execute(options()), 13);
});
test('incomplete containers reuse committed external calls on recovery and changed definitions reject snapshots', async () => {
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const definition = {
    ...base,
    require: { work: { contract: contract.id } },
    steps: [
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 2,
        steps: [
          { id: 'work', type: 'invoke', use: 'work' },
          {
            id: 'advance',
            type: 'state',
            state: { count: '${{ state.count + steps.work.output }}' },
          },
        ],
      },
    ],
  };
  const policy = compilePolicy(definition, {
    contracts: { contract: () => contract },
  });
  let snapshot: JsonObject = {};
  let interrupted = false;
  let calls = 0;
  const runOptions = {
    ...options(),
    invoke: async () => {
      calls++;
      return 1;
    },
    checkpoint: async (value: JsonObject) => {
      snapshot = value;
      if (
        !interrupted &&
        (value.journal as JsonObject)['steps/repeat/iteration-0/work']
      ) {
        interrupted = true;
        throw new Error('call committed');
      }
    },
  };
  await assert.rejects(policy.execute(runOptions), /call committed/);
  assert.equal(calls, 1);
  assert.equal(await policy.execute({ ...runOptions, restore: snapshot }), 2);
  assert.equal(calls, 2);
  assert.equal(await policy.execute({ ...runOptions, restore: snapshot }), 2);
  assert.equal(calls, 2);
  await assert.rejects(
    compilePolicy(
      { ...definition, output: 99 },
      { contracts: { contract: () => contract } },
    ).execute({ ...runOptions, restore: snapshot }),
    /identity/,
  );
});
test('foreach waits for launched branches after failure and dispatches no further items', async () => {
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = compilePolicy(
    {
      ...base,
      require: { work: { contract: contract.id } },
      steps: [
        {
          id: 'each',
          type: 'foreach',
          foreach: [0, 1, 2, 3],
          as: 'item',
          key: '${{ item }}',
          concurrency: 2,
          steps: [
            { id: 'work', type: 'invoke', use: 'work', with: '${{ item }}' },
          ],
        },
      ],
    },
    { contracts: { contract: () => contract } },
  );
  let release!: () => void;
  let started!: () => void;
  const launched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched: JsonValue[] = [];
  let settled = false;
  const running = policy
    .execute({
      ...options(),
      invoke: async (_name, value) => {
        dispatched.push(value);
        if (value === 0) throw new Error('branch failure');
        started();
        await gate;
        return null;
      },
    })
    .finally(() => {
      settled = true;
    });
  await launched;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(dispatched, [0, 1]);
  release();
  await assert.rejects(running, /branch failure/);
  assert.deepEqual(dispatched, [0, 1]);
});
test('parallel ancestors apply to nested serial foreach and Reflection', async () => {
  const definition = {
    ...base,
    defaults: { reflection: { configFile: 'reflection.yaml' } },
    config_schema: { type: 'object' },
    steps: [
      {
        id: 'outer',
        type: 'foreach',
        foreach: [1],
        as: 'outerItem',
        key: '${{ outerItem }}',
        concurrency: '${{ config.concurrency }}',
        steps: [
          {
            id: 'inner',
            type: 'foreach',
            foreach: [1],
            as: 'innerItem',
            key: '${{ innerItem }}',
            concurrency: 1,
            steps: [{ id: 'reflect', type: 'reflection' }],
          },
        ],
      },
    ],
  };
  let calls = 0;
  await assert.rejects(
    compilePolicy(definition).execute({
      ...options(),
      config: { concurrency: 2 },
      reflect: async () => {
        calls++;
        return null;
      },
    }),
    /parallel/,
  );
  assert.equal(calls, 0);
});
test('failed state validation preserves the previous state and nested values despite conditional defaults', async (t) => {
  const { StateStep } = await import('../../src/runtime/policy/index.js');
  const execute = StateStep.prototype.execute;
  let before: JsonObject | undefined;
  let after: JsonObject | undefined;
  StateStep.prototype.execute = async function (context) {
    before = context.state;
    try {
      return await execute.call(this, context);
    } finally {
      after = context.state;
    }
  };
  t.after(() => {
    StateStep.prototype.execute = execute;
  });
  const policy = compilePolicy({
    ...base,
    state_schema: {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        count: { type: 'integer' },
        payload: { type: 'object' },
      },
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { active: { const: true } } },
          then: {
            properties: {
              payload: {
                properties: { injected: { type: 'integer', default: 2 } },
              },
            },
          },
        },
      ],
    },
    state: { active: false, count: 0, payload: {} },
    steps: [
      {
        id: 'invalid',
        type: 'state',
        state: { active: true, count: 'invalid' },
      },
    ],
  });
  let checkpoints = 0;
  await assert.rejects(
    policy.execute({
      ...options(),
      checkpoint: async () => {
        checkpoints++;
      },
    }),
    /policy.state/,
  );
  assert.equal(after, before);
  assert.deepEqual(after, { active: false, count: 0, payload: {} });
  assert.equal(checkpoints, 0);
});
test('serial Reflection preserves result and following invocations observe the activation', async () => {
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = compilePolicy(
    {
      ...base,
      require: { work: { contract: contract.id } },
      defaults: { reflection: { configFile: 'reflection.yaml' } },
      steps: [
        { id: 'reflect', type: 'reflection' },
        { id: 'after', type: 'invoke', use: 'work' },
      ],
      output: {
        reflection: '${{ steps.reflect.output }}',
        actual: '${{ steps.after.output }}',
      },
    },
    { contracts: { contract: () => contract } },
  );
  let active = false;
  const result = {
    reflectionId: 'reflection-one',
    status: 'activated',
    reason: 'validated',
    revisionRefs: { work: 'revision-one' },
  };
  assert.deepEqual(
    await policy.execute({
      ...options(),
      reflect: async (path, state, parallel) => {
        assert.equal(path, 'steps/reflect');
        assert.equal(parallel, false);
        assert.deepEqual(state, { count: 0 });
        active = true;
        return result;
      },
      invoke: async () => (active ? 'revision-one' : 'baseline'),
    }),
    { reflection: result, actual: 'revision-one' },
  );
});

test('state fields declared by patternProperties accept valid updates and enforce value types', async () => {
  const policy = compilePolicy({
    schemaVersion: 'rsi.policy/v1',
    id: 'policy.pattern-state',
    input_schema: { type: 'object' },
    output_schema: { type: 'integer' },
    state_schema: {
      type: 'object',
      patternProperties: { '^metric_': { type: 'integer' } },
      additionalProperties: false,
    },
    state: { metric_score: 0 },
    steps: [{ id: 'update', type: 'state', state: { metric_score: 1 } }],
    output: '${{ state.metric_score }}',
  });
  assert.equal(await policy.execute(options()), 1);
  const invalid = policy.toJSON();
  invalid.steps = [
    { id: 'update', type: 'state', state: { metric_score: 'invalid' } },
  ];
  await assert.rejects(compilePolicy(invalid).execute(options()), /integer/);
});
