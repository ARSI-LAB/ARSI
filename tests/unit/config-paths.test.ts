import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { JsonSchema } from '../../src/contracts/index.js';
import { resolveConfig } from '../../src/runtime/loaders/config.js';

test('configuration paths follow declarations, including nested arrays and local Schema references', () => {
  const directory = resolve('fixtures/recipe');
  const schema: JsonSchema = {
    type: 'object',
    $defs: { file: { type: 'string', 'x-rsi-path': 'file' } },
    properties: {
      instructions: { $ref: '#/$defs/file' },
      prompt: { type: 'string' },
      directory: { type: 'string' },
      skills: {
        type: 'array',
        items: { type: 'string', 'x-rsi-path': 'directory' },
      },
      target: {
        type: 'object',
        properties: {
          schema: { type: ['string', 'object'], 'x-rsi-path': 'file' },
        },
      },
    },
  };
  const config = {
    instructions: './instructions.md',
    prompt: 'literal prompt',
    directory: 'literal directory',
    skills: ['./skills/a', './skills/b'],
    target: { schema: { type: 'object' } },
  };
  assert.deepEqual(resolveConfig(config, directory, schema), {
    instructions: join(directory, 'instructions.md'),
    prompt: 'literal prompt',
    directory: 'literal directory',
    skills: [join(directory, 'skills/a'), join(directory, 'skills/b')],
    target: { schema: { type: 'object' } },
  });
  assert.equal(config.instructions, './instructions.md');
  assert.deepEqual(
    resolveConfig({ target: { schema: './target.yaml' } }, directory, schema),
    {
      target: { schema: join(directory, 'target.yaml') },
    },
  );
});

test('only the applicable union branch declares a path and non-local values remain unchanged', () => {
  const directory = resolve('fixtures/recipe');
  const schema: JsonSchema = {
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { const: 'file' },
          value: { type: 'string', 'x-rsi-path': 'file' },
        },
        required: ['kind'],
      },
      {
        type: 'object',
        properties: { kind: { const: 'literal' }, value: { type: 'string' } },
        required: ['kind'],
      },
    ],
  };
  assert.deepEqual(
    resolveConfig({ kind: 'literal', value: './literal' }, directory, schema),
    { kind: 'literal', value: './literal' },
  );
  assert.deepEqual(
    resolveConfig({ kind: 'file', value: './input' }, directory, schema),
    { kind: 'file', value: join(directory, 'input') },
  );
  for (const value of [
    'https://example.com/input',
    'artifact:reference',
    '${INPUT_PATH}',
    join(directory, 'absolute'),
  ]) {
    assert.equal(
      resolveConfig({ kind: 'file', value }, directory, schema).value,
      value,
    );
  }
});

test('union branch references resolve against the complete root Schema', () => {
  const directory = resolve('fixtures/recipe');
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      template: { type: 'string', 'x-rsi-path': 'file' },
      choice: {
        oneOf: [
          {
            type: 'object',
            properties: { asset: { $ref: '#/properties/template' } },
            required: ['asset'],
          },
          { type: 'null' },
        ],
      },
    },
  };
  assert.deepEqual(
    resolveConfig({ choice: { asset: './input.txt' } }, directory, schema),
    {
      choice: { asset: join(directory, 'input.txt') },
    },
  );
});

test('equivalent named Schemas can be loaded more than once', () => {
  const directory = resolve('fixtures/recipe');
  const schema: JsonSchema = {
    $id: 'https://example.test/config-paths',
    type: 'object',
    oneOf: [
      {
        properties: { asset: { type: 'string', 'x-rsi-path': 'file' } },
        required: ['asset'],
      },
    ],
  };
  for (const declaration of [schema, structuredClone(schema)]) {
    assert.equal(
      resolveConfig({ asset: './asset.txt' }, directory, declaration).asset,
      join(directory, 'asset.txt'),
    );
  }
});
