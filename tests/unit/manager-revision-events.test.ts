import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applicationContract,
  defineContract,
  reflectionContract,
  type Operation,
  type OperationDefinition,
  type RuntimeContext,
  type RevisionActivatedEvent,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';
import { measurementFixture } from '../helpers/manager-fixture.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/revision-chain'(label: string): undefined | Promise<undefined>;
  }
}

test('Manager activates committed revisions before notifying, retains the old chain, and resumes without replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-revision-events-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  t.after(async () => {
    releaseOld();
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const trace: string[] = [];
  const activations: RevisionActivatedEvent[] = [];
  const workerContexts: RuntimeContext[] = [];
  let oldChain: Promise<undefined> | undefined;
  let executions = 0;
  let proposals = 0;
  registry.registerOperation({
    id: 'revision.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
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
  });
  const observer: OperationDefinition = {
    id: 'revision.observer',
    contract: defineContract({
      id: 'contract.revision-observer',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: { type: 'object' },
    async create(_config, services) {
      services.event.on('test/revision-chain', async (label) => {
        if (label === 'old') await oldGate;
        return undefined;
      });
      services.event.on('rsi/revision-activated', async (event, context) => {
        const committed = await context.facts.read(
          'activations',
          event.experimentId,
        );
        assert.equal(committed.activationId, event.activationId);
        assert.equal(
          object(committed.revisions).worker,
          event.revisionRefs.worker,
        );
        trace.push('activation-committed');
        activations.push(event);
        await context.event.serial('test/revision-chain', 'new');
        releaseOld();
      });
      return { execute: async () => ({}), dispose: async () => {} };
    },
  };
  registry.registerOperation(observer);
  const worker: OperationDefinition = {
    id: 'revision.worker',
    contract: defineContract({
      id: 'contract.revision-worker',
      input_schema: { type: 'object', required: ['candidateRef'] },
      output_schema: { type: 'object', required: ['measurementRef', 'prompt'] },
    }),
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: { prompt: { type: 'string', 'x-rsi-path': 'file' } },
    },
    async create(config, services) {
      workerContexts.push(services);
      const prompt = await readFile(string(config.prompt), 'utf8');
      const instance: Operation = {
        async execute(input, context) {
          executions++;
          trace.push(`execute:${prompt}`);
          if (executions === 1)
            oldChain = services.event.serial('test/revision-chain', 'old');
          const measurement = await measurementFixture(context);
          measurement.candidateRef = object(input).candidateRef!;
          measurement.evaluator = {
            pluginId: 'revision.worker',
            implementationDigest: 'test',
          };
          return {
            prompt,
            measurementRef: await context.recordMeasurement(measurement),
          };
        },
        async dispose() {
          trace.push(`dispose:${prompt}`);
        },
      };
      services.event.on('test/revision-chain', (label) => {
        trace.push(`chain:${label}:${prompt}`);
        return undefined;
      });
      return instance;
    },
  };
  registry.registerOperation(worker);
  registry.registerOperation({
    id: 'revision.reflector',
    contract: reflectionContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
      return {
        async execute(input) {
          const request = object(input);
          proposals++;
          if (proposals > 1)
            return {
              status: 'no-change',
              proposal: null,
              reason: 'Already revised',
            };
          const workspace = await services.workspaces.create(
            string(request.resourceRef),
          );
          try {
            await writeFile(
              join(workspace.directory, 'bindings/worker/resources/prompt'),
              'revised',
            );
            await writeFile(
              join(workspace.directory, 'bindings/unused/resources/prompt'),
              'revised-unused',
            );
            return {
              status: 'proposed',
              proposal: {
                parentRevisionRefs: object(request.parentRevisionRefs),
                resourceRef: await services.artifacts.capture(
                  workspace.directory,
                ),
                changeRef: await services.artifacts.putJson({
                  reason: 'Revise the prompt',
                }),
              },
              reason: 'Deterministic test revision',
            };
          } finally {
            await services.workspaces.release(workspace.ref);
          }
        },
        async dispose() {},
      };
    },
  });
  await writeFile(join(root, 'prompt.txt'), 'original');
  await writeFile(join(root, 'unused-prompt.txt'), 'original');
  await writeFile(join(root, 'reflection-goal.md'), 'Revise the prompt');
  await writeFile(
    join(root, 'reflection.yaml'),
    JSON.stringify({
      evidence: ['worker'],
      targets: {
        worker: { resources: ['prompt'] },
        unused: { resources: ['prompt'] },
      },
      goal: './reflection-goal.md',
      implementation: {
        contract: reflectionContract.id,
        ref: 'revision.reflector',
        config: {},
      },
      budget: { modelCalls: 1, timeoutSeconds: 5 },
    }),
  );
  await writeFile(
    join(root, 'policy.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'policy.revision-events',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        observer: { contract: observer.contract.id },
        worker: { contract: worker.contract.id },
        unused: { contract: worker.contract.id },
      },
      defaults: { reflection: { configFile: './reflection.yaml' } },
      state_schema: {
        type: 'object',
        properties: { last: { type: ['object', 'null'] } },
        required: ['last'],
        additionalProperties: false,
      },
      state: { last: null },
      steps: [
        { id: 'observe', type: 'invoke', use: 'observer', with: {} },
        {
          id: 'warmup1',
          type: 'invoke',
          use: 'worker',
          with: { candidateRef: '${{ application.initialCandidate }}' },
        },
        {
          id: 'warmup2',
          type: 'invoke',
          use: 'worker',
          with: { candidateRef: '${{ application.initialCandidate }}' },
        },
        {
          id: 'search',
          type: 'loop',
          maxIterations: 2,
          steps: [
            {
              id: 'work',
              type: 'invoke',
              use: 'worker',
              with: { candidateRef: '${{ application.initialCandidate }}' },
            },
            {
              id: 'retain',
              type: 'state',
              state: { last: '${{ steps.work.output }}' },
            },
            { id: 'improve', type: 'reflection' },
          ],
          output: '${{ state.last }}',
        },
      ],
      output: '${{ steps.search.output }}',
    }),
  );
  registry.registerPolicy('policy.revision-events', join(root, 'policy.yaml'));
  const recipePath = join(root, 'recipe.yaml');
  await writeFile(
    recipePath,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'revision-events',
      application: { plugin: 'revision.application', config: {} },
      policy: { id: 'policy.revision-events', config: {}, input: {} },
      bindings: {
        observer: { plugin: observer.id, config: {} },
        worker: { plugin: worker.id, config: { prompt: './prompt.txt' } },
        unused: {
          plugin: worker.id,
          config: { prompt: './unused-prompt.txt' },
        },
      },
      budget: { operations: 20, elapsedWallMs: 10000, cleanupReserveMs: 1000 },
    }),
  );
  const result = await manager.run(recipePath, { id: 'revision-events' });
  await oldChain;
  assert.equal(result.status, 'succeeded');
  assert.equal(object(result.output).prompt, 'revised');
  assert.equal(activations.length, 1);
  assert.equal(workerContexts.length, 3);
  assert.equal(workerContexts[2]!.bindingId, 'unused');
  assert.notEqual(workerContexts[0]!.callId, workerContexts[1]!.callId);
  assert.notEqual(workerContexts[0]!.directory, workerContexts[1]!.directory);
  assert.deepEqual(activations[0]!.bindingIds, ['worker', 'unused']);
  assert.ok(
    trace.indexOf('activation-committed') < trace.indexOf('dispose:original'),
  );
  assert.ok(
    trace.indexOf('chain:old:original') < trace.indexOf('dispose:original'),
  );
  assert.ok(trace.includes('chain:new:revised'));
  assert.ok(trace.includes('chain:new:revised-unused'));
  assert.equal(
    trace.filter((event) => event === 'dispose:revised-unused').length,
    1,
  );
  const receipts = await manager.facts.list('calls');
  const originalCall = receipts.find(
    (receipt) => receipt.path === 'steps/search/iteration-0/work',
  )!;
  const revisedCall = receipts.find(
    (receipt) => receipt.path === 'steps/search/iteration-1/work',
  )!;
  assert.equal(object(originalCall.output).prompt, 'original');
  assert.equal(object(revisedCall.output).prompt, 'revised');
  assert.equal(revisedCall.revisionRef, activations[0]!.revisionRefs.worker);
  assert.notEqual(originalCall.revisionRef, revisedCall.revisionRef);
  assert.deepEqual(await manager.facts.list('event-diagnostics'), []);
  const beforeResume = [...trace];
  assert.deepEqual(
    await manager.run(recipePath, { id: 'revision-events', resume: true }),
    result,
  );
  assert.deepEqual(trace, beforeResume);
  assert.equal(executions, 4);
  assert.equal(activations.length, 1);
});
