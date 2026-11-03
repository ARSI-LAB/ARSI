import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compilePolicy, readPolicy } from '../../src/runtime/compiler/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

const base = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.compiler',
  input_schema: { type: 'object' },
  output_schema: true,
  output: null,
};

test('conditional branches merge state and yield types but require initialization on both paths', () => {
  const then = {
    steps: [{ id: 'set', state: { value: 1 } }],
    yield: 1,
  };
  const definition = {
    ...base,
    init: {
      steps: [
        {
          id: 'choose',
          if: true,
          then,
          else: {
            steps: [{ id: 'set', state: { value: 'fallback' } }],
            yield: 'fallback',
          },
        },
        { id: 'save', state: { selected: '${{ init.choose.output }}' } },
      ],
    },
    output: '${{ state.value }}',
  };
  const original = structuredClone(definition);
  const compiled = compilePolicy(definition);
  const choice = { anyOf: [{ type: 'integer' }, { type: 'string' }] };
  assert.deepEqual(compiled.stateSchema, {
    type: 'object',
    properties: { value: choice, selected: choice },
    additionalProperties: false,
  });
  assert.deepEqual(definition, original);
  assert.throws(
    () =>
      compilePolicy({
        ...base,
        init: { steps: [{ id: 'choose', if: true, then }] },
        output: '${{ state.value }}',
      }),
    /state.value is not initialized on every path/,
  );
});

test('foreach exposes inferred yields without exposing child outputs or guaranteed state assignments', () => {
  const each = {
    id: 'each',
    foreach: [1, 2],
    as: 'item',
    key: '${{ item }}',
    steps: [{ id: 'write', state: { value: '${{ item }}' } }],
    yield: '${{ init.write.output.value }}',
  };
  const compiled = compilePolicy({
    ...base,
    init: {
      steps: [
        each,
        { id: 'save', state: { values: '${{ init.each.output }}' } },
      ],
    },
    output: '${{ state.values }}',
  });
  assert.deepEqual(compiled.stateSchema, {
    type: 'object',
    properties: {
      value: { type: 'integer' },
      values: { type: 'array', items: { type: 'integer' } },
    },
    additionalProperties: false,
  });
  for (const [output, error] of [
    ['${{ init.write.output }}', /unavailable output init.write/],
    ['${{ state.value }}', /state.value is not initialized on every path/],
  ] as const) {
    assert.throws(
      () => compilePolicy({ ...base, init: { steps: [each] }, output }),
      error,
    );
  }
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
  assert.equal(compiled.directory, directory);
  assert.deepEqual(compiled.definition.input_schema, {
    type: 'object',
    properties: { count: { type: 'integer' } },
  });
  assert.deepEqual(compiled.definition.output_schema, { type: 'integer' });
  await writeFile(
    join(directory, 'schemas', 'value.yaml'),
    '$ref: input.yaml\n',
  );
  await assert.rejects(
    readPolicy(path, registry),
    /Cyclic or deep document reference/,
  );
});
