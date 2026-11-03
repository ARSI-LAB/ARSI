import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/shared/schema.js';
import type { JsonSchema } from '../../src/contracts/index.js';

const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, default: 24 },
    options: {
      type: 'object',
      properties: {
        mode: { enum: ['execution', 'summary'], default: 'execution' },
      },
      additionalProperties: false,
    },
  },
  required: ['options'],
  additionalProperties: false,
};
type Config = { limit: number; options: { mode: 'execution' | 'summary' } };

test('config parsing fills defaults without mutating caller-owned nested data', () => {
  const raw = { options: {} };
  const config = parseConfig<Config>(configSchema, raw, 'test config');
  assert.deepEqual(config, { limit: 24, options: { mode: 'execution' } });
  assert.deepEqual(raw, { options: {} });
});

test('config parsing rejects missing fields, invalid values and unknown fields', () => {
  for (const raw of [
    {},
    { options: {}, limit: 0 },
    { options: { mode: 'invalid' } },
    { options: {}, typo: true },
  ]) {
    assert.throws(
      () => parseConfig<Config>(configSchema, raw, 'test config'),
      /test config:/,
    );
  }
});
