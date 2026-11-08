import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../src/contracts/index.js';
import { nativeConfiguration as agentbenchConfiguration } from '../../src/plugins/evaluator-agentbench/configuration.js';
import { nativeConfiguration as inferencebenchConfiguration } from '../../src/plugins/evaluator-inferencebench/configuration.js';
import type { AgentbenchConfig as EvaluatorConfig } from '../../src/plugins/evaluator-agentbench/schema.js';
import { object } from '../../src/shared/json.js';

test('inferencebench rejects unknown benchmarks before invoking the SDK', () => {
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
    /requires benchmark.name=agentx or aisbench/,
  );
});

test('inferencebench resolves the bundled AISBench SSH profile with the owned endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-aisbench-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const solverConfig = {
    tokenizerPath: '/model',
    remote: {
      ssh: { host: 'benchmark.internal', user: 'benchmark' },
      pythonExecutable: '/opt/aisbench/bin/python',
      aisbenchWorkPath: '/opt/aisbench',
      aisbenchVersion: '1.0.0',
      workRoot: '/tmp/aisbench',
    },
  };
  const config: EvaluatorConfig = {
    services: { workload: {} },
    benchmark: {
      name: 'aisbench',
      config: { workload: { inputLength: 512, concurrency: 4 } },
      solver: { service: 'workload', config: solverConfig },
    },
  };
  const native = inferencebenchConfiguration(
    config,
    {},
    {
      baseUrl: 'http://ascend.internal:8000/v1',
      model: 'served-model',
      credentialRef: 'VLLM_API_KEY',
    },
    directory,
  );
  assert.deepEqual(object(native.benchmark).solver, {
    name: 'aisbench-ssh',
    service: 'workload',
    config: solverConfig,
  });
  assert.deepEqual(object(native.services).workload, {
    model: 'served-model',
    base_url: 'http://ascend.internal:8000/v1',
    api: 'openai-completions',
    api_key: '${VLLM_API_KEY}',
  });
  assert.deepEqual(native.scheduler, { name: 'local', concurrency: 1 });
  const configPath = join(directory, 'evaluator.json');
  const networkConfigPath = join(directory, 'network.yaml');
  await writeFile(configPath, JSON.stringify(native));
  await writeFile(networkConfigPath, '{}');
  const { loadConfig } = await import('ember-evaluator');
  const resolved = await loadConfig(
    configPath,
    {},
    { VLLM_API_KEY: 'EMPTY' },
    { networkConfigPath },
  );
  assert.equal(resolved.experiment.benchmark.name, 'aisbench');
  assert.equal(resolved.experiment.solver.name, 'aisbench-ssh');
  assert.equal(resolved.experiment.solver.service, 'workload');
});

test('agentbench forwards only explicitly configured service output limits', () => {
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
  assert.equal(Object.hasOwn(object(services.default), 'maxTokens'), false);
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
