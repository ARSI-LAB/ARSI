import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  defineContract,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { applicationContract } from '../../src/contracts/plugin-types/index.js';
import { object, string } from '../../src/shared/json.js';

test('Manager reads original resources and resumes completed or interrupted runs after edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-live-resources-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  let reads = 0;
  let interruption: AbortController | undefined;
  registry.registerOperation({
    id: 'test.application',
    contract: applicationContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create(_config, services) {
      return {
        async execute(_input, context) {
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await context.recordCandidate(
              await services.artifacts.putJson({
                kind: 'file-tree',
                files: [],
              }),
              null,
            ),
          };
        },
        async dispose() {},
      };
    },
  });
  const reader: OperationDefinition = {
    id: 'test.reader',
    contract: defineContract({
      id: 'contract.test-reader',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', 'x-rsi-path': 'file' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    async create(config) {
      return {
        async execute() {
          reads++;
          const path = string(config.prompt);
          const content = await readFile(path, 'utf8');
          interruption?.abort(new Error('pause after resource read'));
          interruption = undefined;
          return { path, content };
        },
        async dispose() {},
      };
    },
  };
  registry.registerOperation(reader);
  registry.registerOperation(piDefinition);
  const prompt = join(root, 'prompt.md');
  const recipePath = join(root, 'recipe.yaml');
  try {
    await writeFile(prompt, 'before');
    await writeFile(
      join(root, 'policy.yaml'),
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: { reader: { contract: reader.contract.id } },
        init: { steps: [{ id: 'read', use: 'reader', with: {} }] },
        output: '${{ init.read.output }}',
      }),
    );
    registry.registerPolicy('test.policy', join(root, 'policy.yaml'));
    await writeFile(
      recipePath,
      stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'live',
        application: { ref: 'test.application', config: {} },
        policy: { ref: 'test.policy', config: {}, input: {} },
        bindings: {
          reader: { ref: reader.id, config: { prompt: './prompt.md' } },
        },
        budget: { operations: 3, elapsedWallMs: 10000 },
      }),
    );
    const first = await manager.run(recipePath, { id: 'first' });
    assert.deepEqual(first.output, { path: prompt, content: 'before' });
    await writeFile(prompt, 'after');
    const resumed = await manager.run(recipePath, {
      id: 'first',
      resume: true,
    });
    assert.deepEqual(resumed.output, first.output);
    assert.equal(reads, 1);
    assert.equal((await manager.facts.read('budgets', 'first')).operations, 2);
    const second = await manager.run(recipePath, { id: 'second' });
    assert.equal(object(second.output).content, 'after');
    assert.equal(reads, 2);
    await writeFile(
      join(root, 'policy.yaml'),
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: { reader: { contract: reader.contract.id } },
        init: {
          steps: [
            { id: 'first', use: 'reader', with: {} },
            { id: 'second', use: 'reader', with: {} },
          ],
        },
        output: {
          first: '${{ init.first.output.content }}',
          second: '${{ init.second.output.content }}',
        },
      }),
    );
    interruption = new AbortController();
    await assert.rejects(
      manager.run(recipePath, {
        id: 'interrupted',
        signal: interruption.signal,
      }),
      /pause after resource read/,
    );
    assert.equal((await manager.get('interrupted')).status, 'cancelled');
    await writeFile(prompt, 'edited before resume');
    const continued = await manager.run(recipePath, {
      id: 'interrupted',
      resume: true,
    });
    assert.deepEqual(continued.output, {
      first: 'after',
      second: 'edited before resume',
    });
    assert.equal(reads, 4);
    assert.equal(
      (await manager.facts.read('budgets', 'interrupted')).operations,
      3,
    );
  } finally {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('Manager persists receipts and completed resume does not repeat calls or spend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-manager-'));
  const registry = new Registry();
  let executions = 0;
  const dataDirectory = join(root, 'custom-data');
  const counter: OperationDefinition = {
    id: 'test.counter',
    contract: defineContract({
      id: 'contract.test-counter',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          executions++;
          return { value: executions };
        },
        async dispose() {},
      };
    },
  };
  const app: OperationDefinition = {
    ...counter,
    id: 'test.application',
    contract: applicationContract,
    async create(_config, services) {
      assert.equal(services.dataDirectory, dataDirectory);
      return {
        async execute(_input, context) {
          const artifactRef = await services.artifacts.putJson({
            kind: 'file-tree',
            files: [],
          });
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await context.recordCandidate(
              artifactRef,
              null,
            ),
          };
        },
        async dispose() {},
      };
    },
  };
  registry.registerOperation(app);
  registry.registerOperation(counter);
  registry.registerOperation(piDefinition);
  try {
    await mkdir(join(root, 'baseline'));
    await writeFile(join(root, 'baseline/source.txt'), 'fixed');
    const policy = {
      schemaVersion: 'rsi.policy/v1',
      id: 'test.policy',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        counter: {
          contract: counter.contract.id,
        },
      },
      init: { steps: [{ id: 'count', use: 'counter', with: {} }] },
      output: '${{ init.count.output }}',
    };
    await writeFile(join(root, 'policy.yaml'), stringify(policy));
    registry.registerPolicy('test.policy', join(root, 'policy.yaml'));
    const recipe = {
      schemaVersion: 'rsi.recipe/v1',
      id: 'probe',
      application: {
        ref: 'test.application',
        config: {
          baseline: { directory: join(root, 'baseline') },
          target: { schema: { type: 'object' } },
        },
      },
      policy: { ref: 'test.policy', input: {}, config: {} },
      bindings: { counter: { ref: 'test.counter', config: {} } },
      budget: { operations: 2, elapsedWallMs: 10000 },
    };
    await writeFile(join(root, 'recipe.yaml'), stringify(recipe));
    const manager = new Manager({
      registry,
      rootDirectory: root,
      directory: dataDirectory,
    });
    const result = await manager.run(join(root, 'recipe.yaml'), {
      id: 'probe',
    });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.output, { value: 1 });
    assert.equal(executions, 1);
    const resumed = await manager.run(join(root, 'recipe.yaml'), {
      id: 'probe',
      resume: true,
    });
    assert.equal(resumed.status, 'succeeded');
    assert.equal(executions, 1);
    assert.equal((await manager.facts.read('budgets', 'probe')).operations, 2);
    await manager.dispose();
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
