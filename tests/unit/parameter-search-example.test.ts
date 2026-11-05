import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from 'ember-evaluator';
import { object } from '../../src/shared/json.js';
import { nativeConfiguration } from '../../src/plugins/evaluator-inferencebench/configuration.js';
import { inferenceDefinition } from '../../src/plugins/application-inference/index.js';
import { parseConfig, validate } from '../../src/shared/schema.js';
import {
  configSchema as evaluatorConfigSchema,
  type InferencebenchConfig,
} from '../../src/plugins/evaluator-inferencebench/schema.js';

test('vLLM tuning example uses AgentX against the Application endpoint with matching selection metrics', async () => {
  const recipe = object(
    parse(
      await readFile(
        'examples/artifacts/inference/parameter-grid/recipe.yaml',
        'utf8',
      ),
    ),
  );
  const bindings = object(recipe.bindings);
  validate(inferenceDefinition.configSchema, object(recipe.application).config);
  const evaluator = parseConfig<InferencebenchConfig>(
    evaluatorConfigSchema,
    object(bindings.evaluator).config,
  );
  assert.equal(object(evaluator.benchmark).name, 'agentx');
  const directory = await mkdtemp(join(tmpdir(), 'rsi-agentx-example-'));
  try {
    const native = nativeConfiguration(
      evaluator,
      {},
      {
        baseUrl: 'http://127.0.0.1:8004/v1',
        model: 'owned-model',
        credentialRef: '${VLLM_API_KEY}',
      },
      directory,
    );
    const networkPath = join(directory, 'network.yaml');
    await writeFile(networkPath, '{}\n');
    const configPath = join(directory, 'evaluator.json');
    await writeFile(configPath, JSON.stringify(native));
    const loaded = await loadConfig(
      configPath,
      {},
      {
        EVALUATOR_NETWORK_CONFIG: networkPath,
        VLLM_API_KEY: 'fixture-key',
        AGENTX_TOKENIZER: 'fixture/tokenizer',
        EVALUATOR_CACHE_DIR: join(directory, 'cache'),
      },
    );
    const config = loaded.experiment;
    assert.equal(config.solver.name, 'agentx-replay');
    assert.equal(config.solver.config.tokenizer, 'fixture/tokenizer');
    assert.equal(config.services.default!.endpoint, 'http://127.0.0.1:8004/v1');
    assert.equal(config.services.default!.maxTokens, undefined);
    const workload = config.benchmark.config;
    assert.ok(
      config.run.timeoutSeconds >= Number(workload.durationSeconds) + 3900,
    );
    assert.equal(config.run.onError, 'continue');
    const selector = object(object(bindings.selector).config);
    assert.equal(
      selector.itemId,
      `agentx-${workload.variant}-${workload.mode}-c4`,
    );
    assert.equal(selector.metric, 'outputThroughput');
    assert.deepEqual(selector.constraints, [
      { metric: 'requestLatency', statistic: 'p99', max: 1500 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
