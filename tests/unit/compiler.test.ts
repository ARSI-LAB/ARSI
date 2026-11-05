import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  compilePolicy,
  readPolicy,
  Policy,
} from '../../src/runtime/compiler/index.js';
import {
  InvokeStep,
  StateStep,
  IfStep,
  LoopStep,
  ForEachStep,
  ControlStep,
  ReflectionStep,
} from '../../src/runtime/policy/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

const base = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.compiler',
  input_schema: { type: 'object' },
  output_schema: true,
  steps: [],
  output: null,
};
const invoke = { id: 'call', type: 'invoke', use: 'work' };
const contract = {
  id: 'contract.work',
  input_schema: true,
  output_schema: true,
};
const resolver = { contract: () => contract };
const required = { work: { contract: contract.id } };
test('Policy builds immutable typed Steps and serializes reconstructable normalized declarations', () => {
  const value = {
    ...base,
    require: required,
    state_schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      additionalProperties: false,
    },
    state: { count: 0 },
    defaults: { reflection: { configFile: 'reflection.yaml' } },
    steps: [
      invoke,
      { id: 'set', type: 'state', state: { count: 1 } },
      { id: 'branch', type: 'if', if: true, then: { steps: [] } },
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 0,
        steps: [{ id: 'stop', type: 'control', control: 'break' }],
      },
      {
        id: 'each',
        type: 'foreach',
        foreach: [],
        as: 'item',
        key: '${{ item }}',
        steps: [],
      },
      { id: 'reflect', type: 'reflection' },
    ],
  };
  const policy = compilePolicy(value, {
    contracts: resolver,
    sourcePath: 'policy.yaml',
  });
  assert.ok(policy instanceof Policy);
  for (const [index, Class] of [
    InvokeStep,
    StateStep,
    IfStep,
    LoopStep,
    ForEachStep,
    ReflectionStep,
  ].entries())
    assert.ok(policy.steps[index] instanceof Class);
  assert.ok((policy.steps[3] as LoopStep).steps[0] instanceof ControlStep);
  assert.equal(policy.sourcePath, resolve('policy.yaml'));
  const serialized = policy.toJSON();
  assert.equal(
    compilePolicy(serialized, { contracts: resolver }).digest,
    policy.digest,
  );
  (serialized.state as { count: number }).count = 100;
  assert.equal(policy.stateInitial.count, 0);
  assert.throws(() => {
    policy.stateInitial.count = 100;
  }, TypeError);
  assert.equal(value.state.count, 0);
});
test('lexical output validation rejects forward references and incomplete local shadows', () => {
  const first = { ...invoke, id: 'same' };
  const reference = { ...invoke, id: 'read', with: '${{ steps.same.output }}' };
  const definition = {
    ...base,
    require: required,
    steps: [
      first,
      {
        id: 'branch',
        type: 'if',
        if: true,
        then: { steps: [reference, first] },
      },
    ],
  };
  assert.throws(
    () => compilePolicy(definition, { contracts: resolver }),
    /unavailable output steps.same/,
  );
  assert.throws(
    () =>
      compilePolicy(
        { ...base, require: required, steps: [reference, first] },
        { contracts: resolver },
      ),
    /unavailable output steps.same/,
  );
  compilePolicy(
    {
      ...base,
      require: required,
      steps: [
        first,
        {
          id: 'branch',
          type: 'if',
          if: true,
          then: { steps: [reference], output: '${{ steps.read.output }}' },
        },
      ],
    },
    { contracts: resolver },
  );
  assert.throws(
    () =>
      compilePolicy(
        {
          ...base,
          require: required,
          steps: [
            { id: 'branch', type: 'if', if: true, then: { steps: [first] } },
          ],
          output: '${{ steps.same.output }}',
        },
        { contracts: resolver },
      ),
    /unavailable output/,
  );
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        steps: [
          {
            id: 'repeat',
            type: 'loop',
            maxIterations: 1,
            steps: [
              { id: 'inside', type: 'if', if: true, then: { steps: [] } },
            ],
            output: '${{ steps.inside.output }}',
          },
        ],
      }),
    /unavailable output/,
  );
});
test('only typed new DSL fields and explicit declared state are accepted', () => {
  for (const definition of [
    { ...base, init: { steps: [] } },
    { ...base, steps: [{ id: 'call', use: 'work' }] },
    {
      ...base,
      steps: [{ id: 'call', type: 'invoke', use: 'work', foreach: [] }],
    },
    { ...base, steps: [{ id: 'branch', type: 'if', if: true, then: [] }] },
    {
      ...base,
      steps: [{ id: 'set', type: 'state', state: { undeclared: 1 } }],
    },
    { ...base, state: {} },
    {
      ...base,
      steps: [
        {
          id: 'each',
          type: 'foreach',
          foreach: [],
          as: 'state',
          key: 1,
          steps: [],
        },
      ],
    },
    { ...base, steps: [{ id: 'stop', type: 'control', control: 'break' }] },
    {
      ...base,
      steps: [
        { id: 'stop', type: 'control', control: 'continue', reason: 'bad' },
      ],
    },
    { ...base, steps: [{ id: 'stop', type: 'control', control: 'fail' }] },
    { ...base, steps: [{ id: 'reflection', type: 'reflection' }] },
    { ...base, output: '${{ loop.index }}' },
    { ...base, output: '${{ init.old.output }}' },
  ])
    assert.throws(() => compilePolicy(definition));
});
test('constant resource limits reject invalid values while zero loops and dynamic concurrency remain valid', () => {
  for (const maxIterations of [undefined, -1, 1.5, 'no', null, 100001])
    assert.throws(
      () =>
        compilePolicy({
          ...base,
          steps: [
            {
              id: 'repeat',
              type: 'loop',
              ...(maxIterations === undefined ? {} : { maxIterations }),
              steps: [],
            },
          ],
        }),
      /maxIterations/,
    );
  for (const concurrency of [0, 1.5, 'no', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        compilePolicy({
          ...base,
          steps: [
            {
              id: 'each',
              type: 'foreach',
              foreach: [],
              as: 'item',
              key: 1,
              concurrency,
              steps: [],
            },
          ],
        }),
      /concurrency/,
    );
});
test('parallel restrictions recurse and foreach control boundaries retain outer data visibility', () => {
  const write = { id: 'write', type: 'state', state: {} };
  const each = {
    id: 'each',
    type: 'foreach',
    foreach: [1],
    as: 'item',
    key: '${{ item }}',
    concurrency: 2,
    steps: [{ id: 'nested', type: 'if', if: true, then: { steps: [write] } }],
  };
  assert.throws(() => compilePolicy({ ...base, steps: [each] }), /parallel/);
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        steps: [
          {
            id: 'repeat',
            type: 'loop',
            maxIterations: 1,
            steps: [
              {
                ...each,
                concurrency: 1,
                steps: [{ id: 'stop', type: 'control', control: 'break' }],
              },
            ],
          },
        ],
      }),
    /foreach/,
  );
  compilePolicy({
    ...base,
    steps: [
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: 1,
        steps: [
          {
            ...each,
            concurrency: 1,
            steps: [
              {
                id: 'inner',
                type: 'loop',
                maxIterations: '${{ loop.index }}',
                steps: [{ id: 'stop', type: 'control', control: 'continue' }],
              },
            ],
            output: '${{ loop.index }}',
          },
        ],
      },
    ],
  });
});
test('policy documents resolve nested local references relative to their files and reject cycles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-compiler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new Registry();
  t.after(() => registry.dispose());
  await mkdir(join(directory, 'schemas'));
  await writeFile(join(directory, 'schemas', 'value.yaml'), 'type: integer\n');
  await writeFile(
    join(directory, 'schemas', 'input.yaml'),
    'type: object\nproperties:\n  count:\n    $ref: value.yaml\n',
  );
  const path = join(directory, 'policy.yaml');
  await writeFile(
    path,
    JSON.stringify({
      ...base,
      input_schema: { $ref: 'schemas/input.yaml' },
      output_schema: { $ref: 'schemas/input.yaml#/properties/count' },
      output: 1,
    }),
  );
  const compiled = await readPolicy(path, registry);
  assert.equal(compiled.sourcePath, path);
  assert.equal(compiled.directory, directory);
  assert.deepEqual(compiled.inputSchema, {
    type: 'object',
    properties: { count: { type: 'integer' } },
  });
  assert.deepEqual(compiled.outputSchema, { type: 'integer' });
  await writeFile(
    join(directory, 'schemas', 'value.yaml'),
    '$ref: input.yaml\n',
  );
  await assert.rejects(
    readPolicy(path, registry),
    /Cyclic or deep document reference/,
  );
});
test('unknown contract errors identify the Policy dependency field and preserve their cause', () => {
  const cause = new Error('Unknown contract contract.work');
  assert.throws(
    () =>
      compilePolicy(
        { ...base, require: required },
        {
          contracts: {
            contract() {
              throw cause;
            },
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /require.work.*Unknown contract.*contract.work/,
      );
      assert.equal(error.cause, cause);
      return true;
    },
  );
});
