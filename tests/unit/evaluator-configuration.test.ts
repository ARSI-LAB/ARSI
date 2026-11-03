import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../src/contracts/index.js';
import { nativeConfiguration as agentbenchConfiguration } from '../../src/plugins/evaluator-agentbench/configuration.js';
import { nativeConfiguration as inferencebenchConfiguration } from '../../src/plugins/evaluator-inferencebench/configuration.js';
import type { AgentbenchConfig as EvaluatorConfig } from '../../src/plugins/evaluator-agentbench/schema.js';
import { object } from '../../src/shared/json.js';

test('inferencebench rejects non-AgentX benchmarks before invoking the SDK', () => {
  assert.throws(
    () =>
      inferencebenchConfiguration(
        {
          services: {
            default: { model: 'test', base_url: 'http://localhost' },
          },
          benchmark: { name: 'vllm-serving' },
        },
        {},
        { baseUrl: 'http://localhost', model: 'test' },
        '/call',
      ),
    /requires benchmark.name=agentx/,
  );
});

test('agentbench supplies the default output limit without overriding explicit service limits', () => {
  const config: EvaluatorConfig = {
    services: {
      default: { model: 'test', base_url: 'http://localhost' },
      custom: { model: 'test', base_url: 'http://localhost', maxTokens: 32768 },
    },
    benchmark: { name: 'terminalbench', version: '4.0' },
  };
  const before = structuredClone(config);
  const native = agentbenchConfiguration(
    config,
    { taskIds: ['task/a'] },
    { directory: '/bundle' },
    '/call',
  );
  const services = object(native.services);
  assert.equal(object(services.default).maxTokens, 65536);
  assert.equal(object(services.custom).maxTokens, 32768);
  assert.deepEqual(config, before);
});

test('inferencebench leaves benchmark-controlled output limits unset', () => {
  const native = inferencebenchConfiguration(
    {
      services: { default: { model: 'test', base_url: 'http://localhost' } },
      benchmark: { name: 'agentx' },
    },
    {},
    { baseUrl: 'http://localhost', model: 'test' },
    '/call',
  );
  assert.equal(object(object(native.services).default).maxTokens, undefined);
});

test('agentbench defaults pipeline preparation to local scheduler concurrency', () => {
  const cases: JsonObject[] = [
    { scheduler: { name: 'local', concurrency: 5 } },
    { scheduler: { name: 'local', config: { concurrency: 5 } } },
    { scheduler: 'local' },
    {},
    {
      scheduler: { name: 'local', concurrency: 5 },
      run: { preparation: { mode: 'pipeline' } },
    },
    {
      scheduler: { name: 'local', concurrency: 5 },
      run: { preparation: { concurrency: 2 } },
    },
    {
      scheduler: { name: 'local', concurrency: 5 },
      run: { preparation: { mode: 'pipeline', concurrency: 2, lookahead: 4 } },
    },
    {
      scheduler: { name: 'local', concurrency: 5 },
      run: { preparation: { mode: 'batch' } },
    },
    { scheduler: { name: 'ray', config: { concurrency: 5 } } },
  ];
  const expected = [
    { mode: 'pipeline', concurrency: 5 },
    { mode: 'pipeline', concurrency: 5 },
    { mode: 'pipeline', concurrency: 1 },
    { mode: 'pipeline', concurrency: 1 },
    { mode: 'pipeline', concurrency: 5 },
    { mode: 'pipeline', concurrency: 2 },
    { mode: 'pipeline', concurrency: 2, lookahead: 4 },
    { mode: 'batch' },
    undefined,
  ];
  for (const [index, settings] of cases.entries()) {
    const config: EvaluatorConfig = {
      services: { default: { model: 'test', base_url: 'http://localhost' } },
      benchmark: { name: 'terminalbench', version: '4.0' },
      ...settings,
    };
    const before = structuredClone(config);
    const native = agentbenchConfiguration(
      config,
      { taskIds: ['task/a'] },
      { directory: '/bundle' },
      '/call',
    );
    assert.deepEqual(object(native.run).preparation, expected[index]);
    assert.deepEqual(config, before, 'input configuration remains unchanged');
  }
});
