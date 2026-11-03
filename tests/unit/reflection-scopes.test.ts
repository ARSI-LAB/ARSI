import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentContract,
  applicationContract,
  defineContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';
import { measurementFixture } from '../helpers/manager-fixture.js';

test('a child builtin Reflection resolves its own Agent and failed parent receipts prevent reentry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-child-reflection-agent-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let failChild = true;
  const observed: Array<{
    binding: string;
    request: JsonObject;
    phase: string | undefined;
  }> = [];
  registry.registerOperation({
    id: 'child.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    create: async () => ({
      execute: async (_input, context) => ({
        action: 'initialize',
        target: {},
        capabilities: [],
        initialCandidateRef: await context.recordCandidate(
          await context.artifacts.putJson({ kind: 'file-tree', files: [] }),
          null,
        ),
      }),
      dispose: async () => {},
    }),
  });
  registry.registerOperation({
    id: 'child.agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    create: async () => ({
      execute: async (request, context) => {
        observed.push({
          binding: context.bindingId,
          request: object(request),
          phase: context.phase,
        });
        await context.charge('modelCalls', 1);
        return { edits: [], reason: 'Retain existing guidance' };
      },
      dispose: async () => {},
    }),
  });
  const workerContract = defineContract({
    id: 'contract.child-worker',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  registry.registerOperation({
    id: 'child.worker',
    contract: workerContract,
    configSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', 'x-rsi-path': 'file' } },
      required: ['prompt'],
    },
    create: async () => ({
      execute: async (input, context) => {
        const measurement = await measurementFixture(context);
        measurement.candidateRef = object(input).candidateRef!;
        measurement.evaluator = {
          pluginId: 'child.worker',
          implementationDigest: 'fixture',
        };
        return { measurementRef: await context.recordMeasurement(measurement) };
      },
      dispose: async () => {},
    }),
  });
  const stopContract = defineContract({
    id: 'contract.child-stop',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  registry.registerOperation({
    id: 'child.stop',
    contract: stopContract,
    configSchema: { type: 'object' },
    create: async () => ({
      execute: async () => {
        if (failChild)
          throw new Error('Controlled failure after child Reflection');
        return {};
      },
      dispose: async () => {},
    }),
  });
  registry.registerOperation(reflectionDefinition);
  const childContract = registry.registerContract(
    defineContract({
      id: 'contract.child-policy',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
  );
  await writeFile(join(root, 'prompt.md'), 'Child resources');
  await writeFile(
    join(root, 'reflection.yaml'),
    JSON.stringify({
      evidence: ['worker'],
      targets: { worker: { resources: ['prompt'] } },
      goal: './prompt.md',
      implementation: {
        contract: 'contract.reflection',
        ref: reflectionDefinition.id,
        config: { agentRef: 'localAgent' },
      },
    }),
  );
  await writeFile(
    join(root, 'child.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.child-agent',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        worker: { contract: workerContract.id },
        localAgent: { contract: agentContract.id },
        stop: { contract: stopContract.id },
      },
      defaults: {
        reflection: { configFile: './reflection.yaml' },
        bindings: {
          worker: { ref: 'child.worker', config: { prompt: './prompt.md' } },
          localAgent: { ref: 'child.agent', config: {} },
          stop: { ref: 'child.stop', config: {} },
        },
      },
      init: {
        steps: [
          ...[0, 1, 2].map((index) => ({
            id: `measure${index}`,
            use: 'worker',
            with: { candidateRef: '${{ application.initialCandidate }}' },
          })),
          { id: 'improve', use: 'reflection' },
          { id: 'stop', use: 'stop' },
        ],
      },
      finish: { steps: [{ id: 'review', use: 'reflection' }] },
      output: '${{ finish.review.output }}',
    }),
  );
  await writeFile(
    join(root, 'parent.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.parent-agent',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        child: { contract: childContract.id },
        localAgent: { contract: agentContract.id },
      },
      defaults: {
        bindings: {
          child: { ref: 'policy.child-agent', config: {} },
          localAgent: { ref: 'child.agent', config: {} },
        },
      },
      init: {
        steps: [
          { id: 'child1', use: 'child' },
          { id: 'child2', use: 'child' },
        ],
      },
      output: '${{ init.child2.output }}',
    }),
  );
  registry.registerPolicy('policy.child-agent', join(root, 'child.yaml'));
  registry.registerPolicy('policy.parent-agent', join(root, 'parent.yaml'));
  const recipePath = join(root, 'recipe.yaml');
  await writeFile(
    recipePath,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'child-agent',
      application: { ref: 'child.application', config: {} },
      policy: { ref: 'policy.parent-agent', input: {}, config: {} },
      budget: { modelCalls: 10, operations: 100, elapsedWallMs: 30000 },
    }),
  );
  await assert.rejects(
    manager.run(recipePath, { id: 'failed-child' }),
    /Controlled failure after child Reflection/,
  );
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.binding, 'child.localAgent');
  assert.equal(observed[0]!.request.agentRef, 'child.localAgent');
  assert.equal(observed[0]!.request.maxModelCalls, 50);
  assert.equal(
    object(observed[0]!.request.files)[
      'bindings/child.worker/resources/prompt'
    ],
    'Child resources',
  );
  const receipt = (await manager.facts.list('calls')).find(
    (call) =>
      call.experimentId === 'failed-child' && call.bindingId === 'child',
  )!;
  assert.ok(['failed', 'cancelled'].includes(string(receipt.status)));
  failChild = false;
  for (const status of ['failed', 'unknown', 'cancelled', 'running']) {
    await manager.facts.write('calls', string(receipt.callId), {
      ...receipt,
      status,
    });
    await assert.rejects(
      manager.run(recipePath, { id: 'failed-child', resume: true }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          `Call ${string(receipt.callId)} has unconfirmed/failed effects`,
        ),
    );
    assert.equal(observed.length, 1);
  }
  const success = await manager.run(recipePath, { id: 'successful-child' });
  assert.equal(success.status, 'succeeded');
  assert.equal(observed.length, 3);
  assert.deepEqual(
    observed.map((call) => call.phase),
    ['experiment', 'experiment', 'experiment'],
  );
  assert.ok(observed.every((call) => call.binding === 'child.localAgent'));
  const reflections = (await manager.facts.list('reflection')).filter(
    (fact) => fact.experimentId === 'successful-child',
  );
  assert.equal(reflections.length, 4);
  assert.equal(new Set(reflections.map((fact) => fact.policyScopeId)).size, 2);
  assert.equal(
    reflections.filter((fact) => fact.status === 'no-change').length,
    2,
  );
  assert.equal(
    reflections.filter((fact) => fact.status === 'skipped').length,
    2,
  );
});
