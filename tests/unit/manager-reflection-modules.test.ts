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

test('Reflection preserves root overrides and resumes from locked definitions without repeating completed steps', async (t) => {
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
          event.stepPath === 'steps/improve' &&
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
  const workSteps = [0, 1, 2].map((index) => ({
    id: `work${index}`,
    type: 'invoke',
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
  await writeFile(join(root, 'override-goal.md'), 'root override goal');
  await writeFile(join(root, 'changed-goal.md'), 'changed root goal');
  await writeFile(
    join(root, 'override.yaml'),
    JSON.stringify(config('./override-goal.md')),
  );
  const policy: JsonObject = {
    schemaVersion: 'rsi.policy/v1',
    id: 'scoped.root',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: { worker: { contract: worker.contract.id } },
    defaults: {
      reflection: { configFile: './missing-default.yaml' },
      bindings: {
        worker: { plugin: worker.id, config: { prompt: './prompt.md' } },
      },
    },
    steps: [
      ...workSteps,
      { id: 'improve', type: 'reflection' },
      { id: 'improve_again', type: 'reflection' },
    ],
    output: '${{ steps.improve_again.output }}',
  };
  const policyPath = join(root, 'policy.yaml');
  await writeFile(policyPath, JSON.stringify(policy));
  registry.registerPolicy('scoped.root', policyPath);
  const recipePath = join(root, 'recipe.yaml');
  const recipe: JsonObject = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'scoped',
    application: { plugin: 'scoped.application', config: {} },
    policy: { id: 'scoped.root', input: {}, config: {} },
    reflection: { configFile: './override.yaml' },
    budget: { operations: 100, elapsedWallMs: 30000, cleanupReserveMs: 1000 },
  };
  await writeFile(recipePath, JSON.stringify(recipe));
  interruption = new AbortController();
  await assert.rejects(
    manager.run(recipePath, { id: 'scoped', signal: interruption.signal }),
    /interrupt after Reflection/,
  );
  assert.equal(initializations, 1);
  assert.deepEqual(generations, [
    { binding: '_reflection', goal: 'root override goal' },
  ]);
  const partial = (await manager.facts.list('reflection')).filter(
    (fact) => fact.experimentId === 'scoped',
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0]!.policyScopeId, 'root');
  const resumed = await manager.run(recipePath, { id: 'scoped', resume: true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(object(resumed.output).status, 'skipped');
  assert.equal(initializations, 1);
  assert.equal(generations.length, 1);
  const completed = (await manager.facts.list('reflection')).filter(
    (fact) => fact.experimentId === 'scoped',
  );
  assert.equal(completed.length, 2);
  const initialRevision = (await manager.facts.list('revisions')).find(
    (record) => record.experimentId === 'scoped' && record.binding === 'worker',
  );
  assert(initialRevision);
  const preview = await manager.reflection().show(string(initialRevision.ref));
  assert.equal(
    preview.applicationAllowed,
    true,
    JSON.stringify(preview.restrictions),
  );
  assert.equal(
    object(
      (
        initialRevision.sourceResources as import('../../src/contracts/index.js').JsonValue[]
      )[0],
    ).path,
    join(root, 'prompt.md'),
  );

  assert.equal(
    new Set(completed.map((fact) => object(fact.result).reflectionId)).size,
    2,
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
  await writeFile(policyPath, 'invalid edited source');
  const continued = await manager.run(recipePath, {
    id: 'changed',
    resume: true,
  });
  assert.equal(continued.status, 'succeeded');
  assert.equal(generations.length, beforeChangedResume);
  assert.equal(initializations, 2);
  await writeFile(policyPath, JSON.stringify(policy));
  const fresh = await manager.run(recipePath, { id: 'fresh' });
  assert.equal(fresh.status, 'succeeded');
  assert.equal(generations.at(-1)?.goal, 'changed root goal');

  policy.steps = [
    {
      id: 'parallel',
      type: 'foreach',
      foreach: [1, 2],
      as: 'item',
      key: '${{ item }}',
      concurrency: 2,
      steps: [{ id: 'improve', type: 'reflection' }],
    },
  ];
  policy.output = {};
  await writeFile(policyPath, JSON.stringify(policy));
  const beforeRejected = initializations;
  await assert.rejects(
    manager.run(recipePath, { id: 'parallel' }),
    /parallel.*Reflection|Reflection.*parallel/,
  );
  assert.equal(initializations, beforeRejected);

  // A registered Policy is never a plugin implementation for a requirement.
  registry.registerPolicy('scoped.child', policyPath);
  policy.require = { child: { contract: worker.contract.id } };
  policy.defaults = {
    bindings: { child: { plugin: 'scoped.child', config: {} } },
  };
  policy.steps = [];
  await writeFile(policyPath, JSON.stringify(policy));
  const { reflection: _reflection, ...withoutReflection } = recipe;
  await writeFile(recipePath, JSON.stringify(withoutReflection));
  await assert.rejects(
    manager.run(recipePath, { id: 'child-policy' }),
    /Unknown plugin scoped.child/,
  );
  assert.equal(initializations, beforeRejected);
});
