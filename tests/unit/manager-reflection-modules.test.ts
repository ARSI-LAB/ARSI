import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applicationContract,
  defineContract,
  reflectionContract,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';
import { measurementFixture } from '../helpers/manager-fixture.js';

test('Reflection preserves local child scopes, root overrides and interrupted step recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-reflection-scopes-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let initializations = 0;
  let interruption: AbortController | undefined;
  const generations: { binding: string; goal: string }[] = [];
  registry.registerOperation({
    id: 'scoped.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
      services.event.on('rsi/policy-step-completed', (event) => {
        if (
          event.policyScopeId === 'root' &&
          event.stepPath === 'init/improve' &&
          interruption
        ) {
          const controller = interruption;
          interruption = undefined;
          controller.abort(
            new Error('interrupt after Reflection step checkpoint'),
          );
        }
      });
      return {
        async execute(_input, context) {
          initializations++;
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await context.recordCandidate(
              await context.artifacts.putJson({ kind: 'file-tree', files: [] }),
              null,
            ),
          };
        },
        async dispose() {},
      };
    },
  });
  const worker: OperationDefinition = {
    id: 'scoped.worker',
    contract: defineContract({
      id: 'contract.scoped-worker',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', 'x-rsi-path': 'file' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    async create() {
      return {
        async execute(_input, context) {
          const measurement = await measurementFixture(context);
          measurement.candidateRef = await context.artifacts.putJson({
            candidate: context.callId,
          });
          measurement.evaluator = {
            pluginId: 'scoped.worker',
            implementationDigest: 'test',
          };
          return {
            measurementRef: await context.recordMeasurement(measurement),
          };
        },
        async dispose() {},
      };
    },
  };
  registry.registerOperation(worker);
  registry.registerOperation({
    id: 'scoped.generator',
    contract: reflectionContract,
    configSchema: { type: 'object', additionalProperties: false },
    async create() {
      return {
        async execute(input, context) {
          generations.push({
            binding: context.bindingId,
            goal: string(object(input).goal),
          });
          return {
            status: 'no-change',
            proposal: null,
            reason: 'No model required',
          };
        },
        async dispose() {},
      };
    },
  });
  const childContract = registry.registerContract(
    defineContract({
      id: 'contract.scoped-child',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
  );
  const workSteps = [0, 1, 2].map((index) => ({
    id: `work${index}`,
    use: 'worker',
  }));
  const config = (goal: string): JsonObject => ({
    evidence: ['worker'],
    targets: { worker: { resources: ['prompt'] } },
    goal,
    implementation: {
      contract: reflectionContract.id,
      ref: 'scoped.generator',
      config: {},
    },
    budget: { modelCalls: 0 },
  });
  await writeFile(join(root, 'prompt.md'), 'current guidance');
  await writeFile(join(root, 'child-goal.md'), 'child goal');
  await writeFile(join(root, 'override-goal.md'), 'root override goal');
  await writeFile(join(root, 'changed-goal.md'), 'changed root goal');
  await writeFile(
    join(root, 'child-reflection.yaml'),
    JSON.stringify(config('./child-goal.md')),
  );
  await writeFile(
    join(root, 'override.yaml'),
    JSON.stringify(config('./override-goal.md')),
  );
  await writeFile(
    join(root, 'child.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'scoped.child',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { worker: { contract: worker.contract.id } },
      defaults: {
        reflection: { configFile: './child-reflection.yaml' },
        bindings: {
          worker: { ref: worker.id, config: { prompt: './prompt.md' } },
        },
      },
      init: { steps: [...workSteps, { id: 'improve', use: 'reflection' }] },
      output: '${{ init.improve.output }}',
    }),
  );
  const parent: JsonObject = {
    schemaVersion: 'rsi.policy/v1',
    id: 'scoped.parent',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: {
      child: { contract: childContract.id },
      worker: { contract: worker.contract.id },
    },
    defaults: {
      reflection: { configFile: './missing-default.yaml' },
      bindings: {
        child: { ref: 'scoped.child', config: {} },
        worker: { ref: worker.id, config: { prompt: './prompt.md' } },
      },
    },
    init: {
      steps: [
        { id: 'child1', use: 'child' },
        { id: 'child2', use: 'child' },
        ...workSteps,
        { id: 'improve', use: 'reflection' },
        { id: 'improve_again', use: 'reflection' },
      ],
    },
    output: '${{ init.improve_again.output }}',
  };
  const parentPath = join(root, 'parent.yaml');
  await writeFile(parentPath, JSON.stringify(parent));
  registry.registerPolicy('scoped.child', join(root, 'child.yaml'));
  registry.registerPolicy('scoped.parent', parentPath);
  const recipePath = join(root, 'recipe.yaml');
  await writeFile(
    recipePath,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'scoped',
      application: { ref: 'scoped.application', config: {} },
      policy: { ref: 'scoped.parent', input: {}, config: {} },
      reflection: { configFile: './override.yaml' },
      budget: { operations: 100, elapsedWallMs: 30000, cleanupReserveMs: 1000 },
    }),
  );
  interruption = new AbortController();
  await assert.rejects(
    manager.run(recipePath, { id: 'scoped', signal: interruption.signal }),
    /interrupt after Reflection/,
  );
  assert.equal(initializations, 1);
  assert.deepEqual(generations, [
    { binding: 'child._reflection', goal: 'child goal' },
    { binding: 'child._reflection', goal: 'child goal' },
    { binding: '_reflection', goal: 'root override goal' },
  ]);
  const partial = (await manager.facts.list('reflection')).filter(
    (fact) => fact.experimentId === 'scoped',
  );
  assert.equal(partial.length, 3);
  assert.equal(new Set(partial.map((fact) => fact.policyScopeId)).size, 3);
  const resumed = await manager.run(recipePath, { id: 'scoped', resume: true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(object(resumed.output).status, 'skipped');
  assert.equal(initializations, 1);
  assert.equal(generations.length, 3);
  const completed = (await manager.facts.list('reflection')).filter(
    (fact) => fact.experimentId === 'scoped',
  );
  assert.equal(completed.length, 4);
  assert.equal(
    new Set(completed.map((fact) => object(fact.result).reflectionId)).size,
    4,
  );
  interruption = new AbortController();
  await assert.rejects(
    manager.run(recipePath, { id: 'changed', signal: interruption.signal }),
    /interrupt after Reflection/,
  );
  const beforeChangedResume = generations.length;
  await writeFile(
    join(root, 'override.yaml'),
    JSON.stringify(config('./changed-goal.md')),
  );
  await assert.rejects(
    manager.run(recipePath, { id: 'changed', resume: true }),
    /Reflection configuration source or contents differ/,
  );
  assert.equal(generations.length, beforeChangedResume);
  assert.equal(initializations, 2);
  parent.init = {
    steps: [
      {
        id: 'parallel_children',
        foreach: [1, 2],
        as: 'item',
        key: '${{ item }}',
        concurrency: 2,
        steps: [{ id: 'nested', use: 'child' }],
      },
    ],
  };
  parent.output = {};
  await writeFile(parentPath, JSON.stringify(parent));
  await assert.rejects(
    manager.run(recipePath, { id: 'parallel' }),
    /parallel.*Reflection|Reflection.*parallel/,
  );
  assert.equal(initializations, 2);
  parent.require = { worker: { contract: worker.contract.id } };
  parent.defaults = {
    bindings: {
      worker: { ref: worker.id, config: { prompt: './prompt.md' } },
    },
  };
  parent.init = { steps: workSteps };
  parent.output = {};
  await writeFile(parentPath, JSON.stringify(parent));
  await writeFile(
    recipePath,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'scoped',
      application: { ref: 'scoped.application', config: {} },
      policy: { ref: 'scoped.parent', input: {}, config: {} },
      budget: { operations: 100, elapsedWallMs: 30000 },
    }),
  );
  const unfinished = {
    recipeId: 'scoped',
    status: 'cancelled',
    application: {},
    startedAt: new Date().toISOString(),
  };
  await manager.facts.write('experiments', 'legacy', unfinished);
  await manager.facts.write('reflection', 'legacy-0-guidance', {
    experimentId: 'legacy',
    iteration: 0,
    ruleId: 'guidance',
    status: 'activated',
  });
  await assert.rejects(
    manager.run(recipePath, { id: 'legacy', resume: true }),
    /Legacy Reflection boundary records/,
  );
  await manager.facts.write('experiments', 'legacy-boundary', unfinished);
  await manager.facts.write('checkpoints', 'legacy-boundary', {
    boundaries: { 0: {} },
  });
  await assert.rejects(
    manager.run(recipePath, { id: 'legacy-boundary', resume: true }),
    /Legacy Reflection boundary checkpoint/,
  );
  assert.equal(initializations, 2);
  await manager.facts.write('experiments', 'without-reflection', unfinished);
  await manager.facts.write('checkpoints', 'without-reflection', {
    boundaries: { completed: null },
  });
  await manager.facts.write('budgets', 'without-reflection', {});
  assert.equal(
    (
      await manager.run(recipePath, {
        id: 'without-reflection',
        resume: true,
      })
    ).status,
    'succeeded',
  );
  assert.equal(initializations, 3);
});
