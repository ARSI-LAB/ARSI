import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, loadConfig } from 'ember-evaluator';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import type { AgentbenchConfig as EvaluatorConfig } from '../../src/plugins/evaluator-agentbench/schema.js';
import type { InferencebenchConfig } from '../../src/plugins/evaluator-inferencebench/schema.js';
import { object } from '../../src/shared/json.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Binding } from '../../src/runtime/loaders/binding.js';
import { agentbenchDefinition } from '../../src/plugins/evaluator-agentbench/index.js';
import { inferencebenchDefinition } from '../../src/plugins/evaluator-inferencebench/index.js';
import { createAgentbench } from '../../src/plugins/evaluator-agentbench/service.js';
import { createInferencebench } from '../../src/plugins/evaluator-inferencebench/service.js';
import { captureEvaluatorConfiguration } from '../fixtures/evaluator-configuration.js';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-evaluator-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function agentbenchConfiguration(
  config: EvaluatorConfig,
  input: { taskIds: string[] },
  execution: JsonObject,
  directory: string,
): Promise<JsonObject> {
  return captureEvaluatorConfiguration(
    await createAgentbench(config, new RuntimeContext()),
    { candidateRef: 'candidate', ...input },
    execution,
    directory,
  );
}

async function inferencebenchConfiguration(
  config: InferencebenchConfig,
  execution: JsonObject,
  directory: string,
): Promise<JsonObject> {
  return captureEvaluatorConfiguration(
    await createInferencebench(config, new RuntimeContext()),
    { candidateRef: 'candidate' },
    execution,
    directory,
  );
}

test('Evaluator plugins persist SDK-normalized settings without mutating the input or injecting defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-evaluator-passthrough-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = {
    hardware: 'gpu',
    scheduler: { concurrency: 1 },
    store: 'local',
    reporter: 'markdown',
    metrics: [
      'duration',
      { name: 'usage', config: { custom: { enabled: true } } },
    ],
    run: { timeoutSeconds: 12000, includeTaskAnswer: true },
  } satisfies Omit<EvaluatorConfig, 'services' | 'benchmark'>;
  const options = { contextWindow: 8192, retry: { maxAttempts: 2 } };
  for (const { kind, config } of [
    {
      kind: 'agentbench' as const,
      config: {
        ...common,
        benchmark: 'gsm8k',
        services: {
          default: {
            ...options,
            model: 'template',
            base_url: 'https://template.invalid',
          },
        },
      },
    },
    {
      kind: 'inferencebench' as const,
      config: {
        ...common,
        benchmark: 'agentx',
        services: { default: options },
      },
    },
  ]) {
    const before = structuredClone(config);
    const execution = {
      directory: '/candidate',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'candidate',
    };
    const native =
      kind === 'agentbench'
        ? await captureEvaluatorConfiguration(
            await createAgentbench(config, new RuntimeContext()),
            { candidateRef: 'candidate', taskIds: ['task/a'] },
            execution,
            join(directory, kind),
          )
        : await captureEvaluatorConfiguration(
            await createInferencebench(config, new RuntimeContext()),
            { candidateRef: 'candidate' },
            execution,
            join(directory, kind),
          );
    assert.equal(native.hardware, 'gpu');
    assert.equal(object(native.benchmark).name, config.benchmark);
    assert.deepEqual(native.scheduler, { config: { concurrency: 1 } });
    assert.deepEqual(native.store, { name: 'local', config: {} });
    assert.deepEqual(native.reporter, { name: 'markdown', config: {} });
    assert.deepEqual(native.metrics, [
      { name: 'duration', config: {} },
      { name: 'usage', config: { custom: { enabled: true } } },
    ]);
    assert.equal(native.environment, undefined);
    assert.equal(object(native.run).timeoutSeconds, 12000);
    assert.equal(object(native.run).includeTaskAnswer, true);
    const service = object(object(native.services).default);
    assert.equal(service.contextWindow, 8192);
    assert.deepEqual(service.retry, { maxAttempts: 2 });
    assert.deepEqual(config, before);
  }
});

test('Evaluator plugins check native configuration before charging or invoking the SDK', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  const directory = await mkdtemp(join(tmpdir(), 'rsi-evaluator-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sdkCalls = 0,
    charges = 0,
    acquired = 0,
    released = 0;
  const runner = async (): Promise<unknown> => {
    sdkCalls++;
    throw new Error('Unexpected SDK invocation');
  };
  registry.registerOperation({
    ...agentbenchDefinition,
    create: (config: EvaluatorConfig, context) =>
      createAgentbench(config, context, runner),
  });
  registry.registerOperation({
    ...inferencebenchDefinition,
    create: (config: InferencebenchConfig, context) =>
      createInferencebench(config, context, runner),
  });
  const context = new RuntimeContext().extend({
    directory,
    signal: new AbortController().signal,
    charge: async () => {
      charges++;
      throw new Error('Invalid configuration reached evaluation budget');
    },
    withInstance: async (_candidate, _capability, use) => {
      acquired++;
      try {
        return await use({
          directory,
          baseUrl: 'http://127.0.0.1:8000/v1',
          model: 'candidate',
        });
      } finally {
        released++;
      }
    },
  });
  for (const definition of [agentbenchDefinition, inferencebenchDefinition]) {
    const service: JsonObject =
      definition === agentbenchDefinition
        ? { model: 'test', base_url: 'http://localhost' }
        : {};
    const config: JsonObject = {
      hardware: 'gpu',
      services: { default: service },
      benchmark:
        definition === agentbenchDefinition ? 'terminalbench' : 'agentx',
    };
    const bind = (value: JsonObject) =>
      Binding.resolve({
        name: 'evaluator',
        required: definition.contract,
        registry,
        override: {
          declaration: { plugin: definition.id, config: value },
          directory: '/recipe',
        },
      });
    const binding = bind(config);
    assert.deepEqual(binding.config, config);
    const operation = await binding.definition.create(binding.config, context);
    await operation.dispose();
    const invalidConfigs: JsonObject[] = [
      { ...config, unexpected: true },
      {
        ...config,
        services: {
          default: {
            ...service,
            maxTokens: 0,
          },
        },
      },
      { ...config, scheduler: { concurrency: 2, config: { concurrency: 3 } } },
      { ...config, output: { directory: '/caller-output' } },
      {
        ...config,
        services: {
          default: {
            ...service,
            api_key: 'fixture-secret',
          },
        },
      },
    ];
    if (definition === agentbenchDefinition) {
      invalidConfigs.push(
        {
          ...config,
          benchmark: { name: 'terminalbench', solver: 'simpleagent' },
        },
        {
          ...config,
          benchmark: {
            name: 'terminalbench',
            solver: { config: { path: '/caller-bundle' } },
          },
        },
      );
    } else {
      invalidConfigs.push(
        { ...config, benchmark: 'gsm8k' },
        { ...config, environment: 'docker' },
      );
    }
    for (const invalid of invalidConfigs) {
      // Runtime owns the generic object boundary; the evaluator owns SDK rules.
      const invalidBinding = binding.withConfig(bind(invalid).config);
      await assert.rejects(async () => {
        const invalidOperation = await invalidBinding.definition.create(
          invalidBinding.config,
          context,
        );
        try {
          await invalidOperation.execute(
            {
              candidateRef: 'candidate',
              ...(definition === agentbenchDefinition
                ? { taskIds: ['task/a'] }
                : {}),
            },
            context,
          );
        } finally {
          await invalidOperation.dispose();
        }
      }, /supplied by the Application|configuration|services.default.maxTokens|duplicates|api_key|owned by RSI|must be agentbundle|requires benchmark.name=agentx|requires local AgentX/);
    }
  }
  assert.equal(sdkCalls, 0);
  assert.equal(charges, 0);
  assert.equal(acquired, released);
  await assert.rejects(readFile(join(directory, 'evaluator.json')), {
    code: 'ENOENT',
  });
});

test('inferencebench passes AgentX limits through and the SDK enforces them', async (t) => {
  const directory = await temporaryDirectory(t);
  const networkConfigPath = join(directory, 'network.yaml');
  await writeFile(networkConfigPath, '{}\n');
  for (const [index, config] of [
    {
      services: { default: { maxTokens: 32 } },
      benchmark: 'agentx',
    },
    {
      benchmark: 'agentx',
      scheduler: { concurrency: 2 },
    },
  ].entries()) {
    const callDirectory = join(directory, String(index));
    await inferencebenchConfiguration(
      { ...config, hardware: 'gpu' },
      {
        model: 'candidate',
        baseUrl: 'http://127.0.0.1:8000/v1',
        credentialRef: 'TEST_KEY',
      },
      callDirectory,
    );
    const loaded = await loadConfig(
      join(callDirectory, 'evaluator.json'),
      {},
      {
        TEST_KEY: 'fixture-key',
        EVALUATOR_CACHE_DIR: join(directory, 'cache'),
      },
      { networkConfigPath },
    );
    await assert.rejects(async () => {
      const components = await bootstrap(loaded, callDirectory);
      await components.dispose();
    }, /maxTokens|concurrency=1/);
  }
});

test('agentbench binds the exact task set while preserving SDK configuration and caller input', async (t) => {
  const directory = await temporaryDirectory(t);
  const config: EvaluatorConfig = {
    services: { default: { model: 'test', base_url: 'http://localhost' } },
    benchmark: {
      name: 'terminalbench',
      solver: 'agentbundle',
      config: { custom: { nested: true } },
    },
    run: { maxTasks: 1, offset: 5, sampling: { strategy: 'random', seed: 42 } },
  };
  const before = structuredClone(config);
  const native = await agentbenchConfiguration(
    config,
    { taskIds: ['task/b', 'task/a'] },
    { directory: '/bundle' },
    directory,
  );
  assert.deepEqual(native.run, {
    maxTasks: null,
    taskIds: ['task/b', 'task/a'],
  });
  assert.deepEqual(object(native.benchmark).config, {
    custom: { nested: true },
  });
  assert.deepEqual(object(native.benchmark).solver, {
    name: 'agentbundle',
    config: { path: '/bundle' },
  });
  assert.deepEqual(native.output, { directory: join(directory, 'sdk') });
  assert.deepEqual(config, before);
});

test('inferencebench rejects non-AgentX benchmarks before invoking the SDK', async (t) => {
  const directory = await temporaryDirectory(t);
  await assert.rejects(
    () =>
      inferencebenchConfiguration(
        {
          benchmark: { name: 'vllm-serving' },
        },
        { baseUrl: 'http://localhost', model: 'test' },
        directory,
      ),
    /requires benchmark.name=agentx/,
  );
});

test('agentbench forwards only explicitly configured service output limits', async (t) => {
  const directory = await temporaryDirectory(t);
  const config: EvaluatorConfig = {
    services: {
      default: { model: 'test', base_url: 'http://localhost' },
      custom: { model: 'test', base_url: 'http://localhost', maxTokens: 32768 },
    },
    benchmark: { name: 'terminalbench', version: '4.0' },
  };
  const before = structuredClone(config);
  const native = await agentbenchConfiguration(
    config,
    { taskIds: ['task/a'] },
    { directory: '/bundle' },
    directory,
  );
  const services = object(native.services);
  assert.equal(Object.hasOwn(object(services.default), 'maxTokens'), false);
  assert.equal(object(services.custom).maxTokens, 32768);
  assert.deepEqual(config, before);
});

test('inferencebench leaves benchmark-controlled output limits unset', async (t) => {
  const directory = await temporaryDirectory(t);
  const native = await inferencebenchConfiguration(
    {
      benchmark: { name: 'agentx', solver: 'agentx-replay' },
    },
    { baseUrl: 'http://localhost', model: 'test' },
    directory,
  );
  assert.equal(object(object(native.services).default).maxTokens, undefined);
});

test('inferencebench binds only the routed Application service and preserves the template', async (t) => {
  const directory = await temporaryDirectory(t);
  const registry = new Registry();
  t.after(() => registry.dispose());
  registry.registerOperation(inferencebenchDefinition);
  const config = {
    benchmark: { name: 'agentx', solver: { service: 'target' } },
    services: {
      target: { retry: { maxAttempts: 2 } },
      judge: { model: 'judge', base_url: 'https://judge.invalid' },
    },
    scheduler: { concurrency: 1 },
  };
  const before = structuredClone(config);
  const binding = Binding.resolve({
    name: 'evaluator',
    required: inferencebenchDefinition.contract,
    registry,
    override: {
      declaration: { plugin: inferencebenchDefinition.id, config },
      directory: '/recipe',
    },
  });
  assert.deepEqual(binding.config, before);
  const native = await inferencebenchConfiguration(
    config,
    {
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'candidate',
      credentialRef: 'CANDIDATE_KEY',
    },
    directory,
  );
  assert.deepEqual(object(native.services).target, {
    retry: { maxAttempts: 2 },
    model: 'candidate',
    base_url: 'http://127.0.0.1:8000/v1',
    api_key: '${CANDIDATE_KEY}',
  });
  assert.deepEqual(object(native.services).judge, config.services.judge);
  assert.deepEqual(config, before);
  await assert.rejects(
    () =>
      inferencebenchConfiguration(
        { ...config, services: { target: {}, judge: {} } },
        {
          baseUrl: 'http://127.0.0.1:8000/v1',
          model: 'candidate',
        },
        directory,
      ),
    /services.judge.model/,
  );
});

test('inferencebench rejects explicit candidate bindings and missing service routes', async (t) => {
  const directory = await temporaryDirectory(t);
  const benchmark = { name: 'agentx', solver: { service: 'candidate' } };
  const execution = { model: 'served', baseUrl: 'http://localhost' };
  for (const field of ['model', 'base_url', 'api_key']) {
    await assert.rejects(
      inferencebenchConfiguration(
        { benchmark, services: { candidate: { [field]: 'from-recipe' } } },
        execution,
        directory,
      ),
      { message: `services.candidate.${field} is supplied by the Application` },
    );
  }
  await assert.rejects(
    inferencebenchConfiguration({ benchmark }, execution, directory),
    /services.candidate must be declared/,
  );
  await assert.rejects(readFile(join(directory, 'evaluator.json')), {
    code: 'ENOENT',
  });
});

test('Evaluator loads bound agent configuration through its public SDK', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-sdk-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = await agentbenchConfiguration(
    {
      hardware: 'gpu',
      services: {
        default: {
          model: 'test',
          base_url: 'https://model.invalid',
          api_key: '${TEST_KEY}',
        },
      },
      benchmark: 'gsm8k',
      scheduler: { concurrency: 3 },
      run: { includeTaskAnswer: true },
    },
    { taskIds: ['task/a'] },
    { directory: join(directory, 'bundle') },
    directory,
  );
  const path = join(directory, 'evaluator.json');
  const networkConfigPath = join(directory, 'network.yaml');
  await writeFile(networkConfigPath, '{}\n');
  await writeFile(path, JSON.stringify(native));
  const loaded = await loadConfig(
    path,
    {},
    { TEST_KEY: 'fixture-key', EVALUATOR_CACHE_DIR: join(directory, 'cache') },
    { networkConfigPath },
  );
  assert.deepEqual(loaded.experiment.run.taskIds, ['task/a']);
  assert.equal(loaded.experiment.run.includeTaskAnswer, true);
  assert.equal(loaded.experiment.solver.name, 'agentbundle');
  assert.equal(loaded.experiment.solver.config.path, join(directory, 'bundle'));
  assert.equal(loaded.experiment.output.directory, join(directory, 'sdk'));
  assert.equal(loaded.experiment.scheduler.config.concurrency, 3);
});

test('agentbench leaves preparation settings and defaults to the SDK', async (t) => {
  const directory = await temporaryDirectory(t);
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
    undefined,
    undefined,
    undefined,
    undefined,
    { mode: 'pipeline' },
    { concurrency: 2 },
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
    const native = await agentbenchConfiguration(
      config,
      { taskIds: ['task/a'] },
      { directory: '/bundle' },
      directory,
    );
    assert.deepEqual(object(native.run).preparation, expected[index]);
    assert.deepEqual(config, before, 'input configuration remains unchanged');
  }
});
