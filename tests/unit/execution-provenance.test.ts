import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  applicationContract,
  defineContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { object, string } from '../../src/shared/json.js';
import { buildRoundLabels } from '../../web/features/experiments/round-label-model.js';

test('Manager loop candidates retain their producer paths through child application calls and label their rounds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-execution-provenance-'));
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: root });
  t.after(async () => {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  registry.registerOperation({
    id: 'test.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, context): Promise<JsonObject> {
          const request = object(input);
          if (request.action === 'initialize')
            return {
              action: 'initialize',
              target: {},
              capabilities: [],
              initialCandidateRef: await context.recordCandidate(
                await context.artifacts.putJson({ baseline: true }),
                null,
              ),
            };
          if (request.action === 'commit')
            return {
              action: 'commit',
              status: 'created',
              candidateRef: await context.recordCandidate(
                string(request.editRef),
                string(request.parentCandidateRef),
              ),
              diffRef: null,
            };
          throw new Error('Unexpected application action');
        },
        async dispose() {},
      };
    },
  });
  const proposerContract = defineContract({
    id: 'contract.test-proposer',
    input_schema: {
      type: 'object',
      properties: { parent: { type: 'string' } },
      required: ['parent'],
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
  });
  registry.registerOperation({
    id: 'test.proposer',
    contract: proposerContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, context) {
          return context.application({
            action: 'commit',
            parentCandidateRef: string(object(input).parent),
            editRef: await context.artifacts.putJson({
              producer: context.callId,
            }),
          });
        },
        async dispose() {},
      };
    },
  });
  const proposal = {
    id: 'propose',
    type: 'invoke',
    use: 'proposer',
    with: { parent: '${{ application.initialCandidate }}' },
  };
  await writeFile(
    join(root, 'policy.yaml'),
    stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'test.policy',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { proposer: { contract: proposerContract.id } },
      steps: [
        {
          id: 'rounds',
          type: 'loop',
          maxIterations: 2,
          steps: [structuredClone(proposal)],
        },
        {
          id: 'other',
          type: 'loop',
          maxIterations: 1,
          steps: [
            {
              id: 'inner',
              type: 'loop',
              maxIterations: 2,
              steps: [structuredClone(proposal)],
            },
          ],
        },
      ],
      output: {},
    }),
  );
  registry.registerPolicy('test.policy', join(root, 'policy.yaml'));
  const recipe = join(root, 'recipe.yaml');
  await writeFile(
    recipe,
    stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'test',
      application: { plugin: 'test.application', config: {} },
      policy: { id: 'test.policy', config: {}, input: {} },
      bindings: { proposer: { plugin: 'test.proposer', config: {} } },
      budget: { operations: 20, elapsedWallMs: 10000 },
    }),
  );
  await manager.run(recipe, { id: 'test' });
  const queries = new ObservationQueries(manager.facts, manager.artifacts);
  const candidates = (await queries.candidates('test')).items;
  const calls = (await queries.calls('test')).items;
  const labels = buildRoundLabels(candidates, calls, []);
  for (const [path, label] of [
    ['steps/rounds/iteration-0/propose', 'Round 1'],
    ['steps/rounds/iteration-1/propose', 'Round 2'],
    ['steps/other/iteration-0/inner/iteration-0/propose', 'Round 1 / Round 1'],
    ['steps/other/iteration-0/inner/iteration-1/propose', 'Round 1 / Round 2'],
  ]) {
    const producer = calls.find((call) => call.path === path);
    assert.ok(producer, path);
    const output = object(
      (await manager.facts.read('calls', producer.callId)).output,
    );
    const candidate = candidates.find(
      (entry) => entry.ref === output.candidateRef,
    );
    assert.ok(candidate, path);
    assert.equal(candidate.originPath, path);
    assert.equal(labels.candidate(candidate.ref), label);
    const child = calls.find((call) => call.parentCallId === producer.callId);
    assert.equal(child?.path, producer.callId);
  }
  assert.equal(candidates.length, 5);
  assert.equal(
    candidates.find((entry) => entry.parentRef === null)?.originPath,
    null,
  );
});
