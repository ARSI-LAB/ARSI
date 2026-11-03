import { RuntimeContext } from '../../src/contracts/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { compilePolicy } from '../../src/runtime/compiler/index.js';
import { executePolicy } from '../../src/runtime/policy/index.js';
import type { JsonObject, JsonValue } from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
const base = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.test',
  input_schema: { type: 'object', additionalProperties: false },
  output_schema: { type: 'integer' },
  init: { steps: [{ id: 'initialize', state: { count: 0 } }] },
  loop: {
    maxIterations: 3,
    steps: [{ id: 'advance', state: { count: '${{ state.count + 1 }}' } }],
  },
  output: '${{ state.count }}',
};
test('v1 state is inferred and complete loop resumes without repeating calls', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerContract({
    id: 'contract.test-integer',
    input_schema: { type: 'object' },
    output_schema: { type: 'integer' },
  });
  const definition = {
    ...base,
    require: {
      work: {
        contract: 'contract.test-integer',
      },
    },
    loop: {
      maxIterations: 3,
      steps: [
        { id: 'invoke', use: 'work' },
        {
          id: 'advance',
          state: { count: '${{ state.count + loop.invoke.output }}' },
        },
      ],
    },
  };
  const policy = compilePolicy(definition, { contracts: registry });
  let checkpoint: JsonObject | undefined;
  let calls = 0;
  let interrupted = false;
  const options = {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    invoke: async () => {
      calls++;
      return 1;
    },
    checkpoint: async (value: JsonObject) => {
      checkpoint = value;
      const journal = value.journal as JsonObject;
      if (!interrupted && journal['loop/0/invoke']) {
        interrupted = true;
        throw new Error('simulated interruption after durable call');
      }
    },
    boundary: async () => {},
  };
  await assert.rejects(
    executePolicy(policy, {}, {}, options),
    /simulated interruption/,
  );
  assert.equal(calls, 1);
  assert.equal(
    await executePolicy(policy, {}, {}, { ...options, restore: checkpoint }),
    3,
  );
  assert.equal(calls, 3);
  assert.equal(
    await executePolicy(policy, {}, {}, { ...options, restore: checkpoint }),
    3,
  );
  assert.equal(calls, 3);
});
test('compiler rejects old protocols, missing ids, shared parallel writes and uninitialized state', () => {
  assert.throws(
    () => compilePolicy({ ...base, schemaVersion: 'rsi.policy/v2' }),
    /v1/,
  );
  assert.throws(
    () => compilePolicy({ ...base, output_schema: { type: 'not-a-type' } }),
    /schema/,
  );

  assert.throws(
    () =>
      compilePolicy({ ...base, init: { steps: [{ state: { count: 0 } }] } }),
    /id/,
  );
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        loop: {
          maxIterations: 1,
          steps: [
            {
              id: 'each',
              foreach: [1, 2],
              as: 'item',
              key: '${{ item }}',
              concurrency: 2,
              steps: [{ id: 'write', state: { count: 1 } }],
            },
          ],
        },
      }),
    /parallel|foreach/,
  );
  assert.throws(
    () => compilePolicy({ ...base, init: { steps: [] } }),
    /state.count|initialized/,
  );
});
test('foreach output keeps source order and control cannot cross its boundary', async () => {
  const policy = compilePolicy({
    ...base,
    output_schema: { type: 'array', items: { type: 'integer' } },
    loop: {
      maxIterations: 1,
      steps: [
        {
          id: 'each',
          foreach: [3, 1, 2],
          as: 'n',
          key: '${{ n }}',
          concurrency: 3,
          steps: [],
          yield: '${{ n }}',
        },
        { id: 'save', state: { result: '${{ loop.each.output }}' } },
      ],
    },
    init: { steps: [{ id: 'initialize', state: { result: [] } }] },
    output: '${{ state.result }}',
  });
  const result = await executePolicy(
    policy,
    {},
    {},
    {
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      invoke: async () => null,
      checkpoint: async () => {},
      boundary: async () => {},
    },
  );
  assert.deepEqual(result, [3, 1, 2]);
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        loop: {
          maxIterations: 1,
          steps: [
            {
              id: 'each',
              foreach: [1],
              as: 'n',
              key: '${{ n }}',
              steps: [{ id: 'exit', control: 'break' }],
            },
          ],
        },
      }),
    /loop|foreach/,
  );
});
test('Harness² keeps H0 fixed, enables memory, and does not invoke Reflection by default', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  const { readPolicy } = await import('../../src/runtime/compiler/index.js');
  const policy = await readPolicy(
    'src/policies/harness2/policy.yaml',
    registry,
  );
  const { loadRecipe, resolveBindings } = await import(
    '../../src/runtime/loaders/index.js'
  );
  const recipe = await loadRecipe('examples/harness/dsh-harness2/recipe.yaml');
  assert.deepEqual(Object.keys(recipe.bindings), [
    'invariantProposer',
    'domainProposer',
    'evaluator',
  ]);
  assert.equal(object(policy.defaults.bindings).evaluator, undefined);
  const bindings = resolveBindings(
    object(policy.defaults.bindings),
    recipe.bindings,
    policy.directory,
  );
  assert.equal(bindings['agent.default'], undefined);
  assert.equal(bindings.agent?.ref, 'agent.pi');
  assert.equal(bindings.agent?.config.model, '${MODEL_NAME}');
  assert.equal(bindings.agent?.config.base_url, '${MODEL_ENDPOINT}');
  assert.equal(bindings.agent?.config.api_key, '${MODEL_API_KEY}');
  assert.equal(bindings.evaluator?.ref, 'evaluator.agentbench');
  for (const name of ['invariantProposer', 'domainProposer', 'composer']) {
    assert.equal(bindings[name]?.ref, 'proposer.agent');
  }
  assert.equal(bindings.selector?.ref, 'selector.artifact');
  for (const name of [
    'invariantProposer',
    'domainProposer',
    'composer',
    'selector',
    'memoryUpdater',
  ]) {
    assert.equal(bindings[name]?.config.agentRef, 'agent');
  }
  let evaluations = 0,
    memories = 0;
  const parents: string[] = [];
  const output = await executePolicy(
    policy,
    { candidateRef: 'h0' },
    {
      k: 1,
      concurrency: 1,
      dataset: { taskIds: ['task-one'] },
    },
    {
      application: { initialCandidate: 'h0' },
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async () => {},
      boundary: async () => {},
      reflect: async () => {
        assert.fail('Reflection must not run without an invocation step');
      },
      invoke: async (name, input): Promise<JsonValue> => {
        const value = input as JsonObject;
        if (name === 'evaluator') {
          evaluations++;
          return { measurementRef: `m${evaluations}` };
        }
        if (name === 'selector')
          return {
            candidateRef: 'composed',
            measurementRef: 'm4',
            decisionRef: 'decision',
          };
        if (name === 'memoryUpdater') {
          memories++;
          assert.deepEqual(value.evidenceRefs, ['m1', 'm2', 'm3', 'm4']);
          const comparison = object(value.comparison);
          assert.equal(comparison.baselineCandidateRef, 'h0');
          assert.deepEqual(Object.keys(object(comparison.probes)), [
            'base',
            'invariant',
            'domain',
            'compose',
          ]);
          assert.equal(object(comparison.selection).candidateRef, 'composed');
          assert.equal(object(comparison.selection).measurementRef, 'm4');
          return {
            status: 'updated',
            memoryRef: 'wiki',
            changeRef: 'change',
            reason: 'observed',
          };
        }
        parents.push(String(value.parent));
        return {
          status: 'created',
          candidateRef: name === 'composer' ? 'composed' : name,
          diffRef: 'diff',
          rationale: 'evidence',
        };
      },
    },
  );
  assert.equal(evaluations, 4);
  assert.equal(memories, 1);
  assert.deepEqual(parents, ['h0', 'h0', 'h0']);
  assert.deepEqual(output, {
    baseline: 'h0',
    deliveries: [
      {
        candidateRef: 'composed',
        measurementRef: 'm4',
        decisionRef: 'decision',
      },
    ],
  });
  const wiki = await readPolicy('src/policies/wikiskill/policy.yaml', registry);
  await assert.rejects(
    executePolicy(
      wiki,
      { candidateRef: 'h0' },
      {
        dataset: {
          trainTaskIds: ['same'],
          validationTaskIds: ['validation'],
          testTaskIds: ['same'],
        },
      },
      {
        application: {},
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        invoke: async () => {
          throw new Error(
            'Evaluator must not be called for overlapping splits',
          );
        },
        checkpoint: async () => {},
        boundary: async () => {},
      },
    ),
    /duplicate foreach key/,
  );
});
test('replacement bindings do not inherit another implementation config and reject unknown fields', async () => {
  const { parseBinding, resolveBindings } = await import(
    '../../src/runtime/loaders/index.js'
  );
  const recipeDirectory = resolve('fixtures/recipe');
  const policyDirectory = resolve('fixtures/policy');
  const replacement = resolveBindings(
    { worker: { ref: 'plugin.one', config: { privateOption: 'old' } } },
    { worker: { ref: 'plugin.two', config: {} } },
    policyDirectory,
  );
  assert.deepEqual(replacement.worker?.config, {});
  assert.throws(
    () =>
      parseBinding(
        { ref: 'plugin.one', config: {}, unknown: true },
        recipeDirectory,
      ),
    /unknown field/,
  );
});
test('contract defaults cannot mutate Policy state through a call argument', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerContract({
    id: 'contract.test-input-defaults',
    input_schema: {
      type: 'object',
      properties: { injected: { type: 'integer', default: 1 } },
    },
    output_schema: { type: 'integer' },
  });
  const policy = compilePolicy(
    {
      ...base,
      require: {
        work: {
          contract: 'contract.test-input-defaults',
        },
      },
      init: { steps: [{ id: 'initialize', state: { payload: {} } }] },
      loop: {
        maxIterations: 1,
        steps: [{ id: 'invoke', use: 'work', with: '${{ state.payload }}' }],
      },
      output_schema: { type: 'object', additionalProperties: false },
      output: '${{ state.payload }}',
    },
    { contracts: registry },
  );
  const result = await executePolicy(
    policy,
    {},
    {},
    {
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      invoke: async (_binding, input) => {
        assert.deepEqual(input, { injected: 1 });
        return 1;
      },
      checkpoint: async () => {},
      boundary: async () => {},
    },
  );
  assert.deepEqual(result, {});
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        init: {
          steps: [{ id: 'initialize', state: { self: '${{ state }}' } }],
        },
      }),
    /unbounded|recursive/,
  );
});
