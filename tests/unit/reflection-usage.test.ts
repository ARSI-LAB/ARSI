import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentContract,
  applicationContract,
  defineContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import { object, string } from '../../src/shared/json.js';
import { measurementFixture } from '../helpers/manager-fixture.js';
test('Reflection without a local budget exceeds 50 calls and a subsequent Proposer uses the revised prompt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-reflection-use-'));
  const runtime = await createRuntime({ rootDirectory: directory });
  t.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const { registry, manager } = runtime;
  await writeFile(join(directory, 'propose.md'), 'Propose carefully.');
  let generated = 0;
  const prompts: string[] = [];
  registry.registerOperation({
    id: 'usage.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(raw, context): Promise<JsonObject> {
          const input = object(raw);
          if (input.action === 'commit')
            return {
              action: 'commit',
              status: 'no-change',
              candidateRef: string(input.parentCandidateRef),
              diffRef: null,
            };
          assert.equal(input.action, 'initialize');
          const artifact = await context.artifacts.putJson({
            kind: 'file-tree',
            files: [],
          });
          return {
            action: 'initialize',
            initialCandidateRef: await context.recordCandidate(artifact, null),
            capabilities: [],
            target: {},
          };
        },
        async dispose() {},
      };
    },
  });
  const observationContract = defineContract({
    id: 'contract.usage-observer',
    input_schema: { type: 'object', required: ['candidateRef'] },
    output_schema: { type: 'object', required: ['measurementRef'] },
  });
  registry.registerOperation({
    id: 'usage.observer',
    contract: observationContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, context) {
          const measurement = await measurementFixture(context);
          measurement.candidateRef = object(input).candidateRef!;
          measurement.evaluator = {
            pluginId: 'usage.observer',
            implementationDigest: 'test',
          };
          return {
            measurementRef: await context.recordMeasurement(measurement),
          };
        },
        async dispose() {},
      };
    },
  });
  registry.registerOperation({
    id: 'usage.agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(raw, context) {
          const request = object(raw);
          if (string(request.message).includes('Improve the Proposer prompt')) {
            generated++;
            assert.equal(request.maxModelCalls, undefined);
            assert.equal(context.scope?.limits.modelCalls, undefined);
            assert.equal(context.scope?.limits.elapsedWallMs, undefined);
            assert.ok(
              (
                await readFile(join(string(request.cwd), 'AGENTS.md'), 'utf8')
              ).trim(),
            );
            for (let i = 0; i < 51; i++) await context.charge('modelCalls', 1);
            return {
              edits: [
                {
                  path: 'resources/proposer/prompt',
                  content: 'Verify applicability first.',
                },
              ],
              reason: 'Clarify the verification step',
            };
          }
          prompts.push(
            await readFile(join(string(request.cwd), 'AGENTS.md'), 'utf8'),
          );
          return { edits: [], reason: 'Keep the candidate' };
        },
        async dispose() {},
      };
    },
  });
  const policy = {
    schemaVersion: 'rsi.policy/v1',
    id: 'usage.policy',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: {
      observer: { contract: observationContract.id },
      proposer: { contract: 'contract.proposer' },
      agent: { contract: agentContract.id },
    },
    defaults: {
      memory: false,
      reflection: { configFile: './reflection.yaml' },
      bindings: {
        observer: { plugin: 'usage.observer', config: {} },
        proposer: {
          plugin: 'proposer.agent',
          config: {
            prompt: './propose.md',
            agentRef: 'agent',
          },
        },
        agent: { plugin: 'usage.agent', config: {} },
      },
    },
    output: {},
    steps: [
      ...[1, 2, 3].map((i) => ({
        id: `observe_${i}`,
        type: 'invoke',
        use: 'observer',
        with: { candidateRef: '${{ application.initialCandidate }}' },
      })),
      {
        id: 'propose',
        type: 'invoke',
        use: 'proposer',
        with: {
          parent: '${{ application.initialCandidate }}',
          goal: 'Propose a candidate',
          evidenceRefs: [],
        },
      },
    ],
  };
  await writeFile(join(directory, 'policy.yaml'), JSON.stringify(policy));
  registry.registerPolicy('usage.policy', join(directory, 'policy.yaml'));
  await writeFile(
    join(directory, 'reflection.yaml'),
    JSON.stringify({
      trigger: { on: 'after-step', step: 'observe_3' },
      evidence: { includeBindings: ['observer'] },
      targets: { include: { proposer: ['prompt'] } },
      goal: './goal.md',
      implementation: {
        ref: 'reflection.agent',
        config: { agentRef: 'agent' },
      },
    }),
  );
  await writeFile(join(directory, 'goal.md'), 'Improve the Proposer prompt');
  const recipePath = join(directory, 'recipe.yaml');
  await writeFile(
    recipePath,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'usage.recipe',
      application: { plugin: 'usage.application', config: {} },
      policy: { id: 'usage.policy', config: {}, input: {} },
      bindings: {},
      budget: { modelCalls: 60, operations: 20, elapsedWallMs: 30000 },
    }),
  );
  const result = await manager.run(recipePath, { id: 'usage.experiment' });
  assert.equal(result.status, 'succeeded');
  assert.equal(
    (await manager.facts.list('evolution-runs'))[0]?.status,
    'activated',
  );
  assert.equal(generated, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Verify applicability first/);
  assert.equal(
    await readFile(join(directory, 'propose.md'), 'utf8'),
    'Propose carefully.',
  );
  const calls = await manager.facts.list('calls');
  const proposerCall = calls.find((call) => call.bindingId === 'proposer');
  assert.ok(proposerCall);
  const revisions = object(object(result.evolution).revisionRefs);
  assert.equal(proposerCall.revisionRef, revisions.proposer);
  const budgets: JsonObject = await manager.facts.read(
    'budgets',
    'usage.experiment',
  );
  assert.equal(budgets.modelCalls, 51);
});
test('real Proposer calls without Measurements expose linked versions, actual Agent requests, traces and candidate patches', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rsi-reflection-proposer-evidence-'),
  );
  const runtime = await createRuntime({ rootDirectory: directory });
  t.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const { registry, manager } = runtime;
  await writeFile(
    join(directory, 'proposer.md'),
    'Use the current evidence to propose a concrete edit.',
  );
  await writeFile(join(directory, 'goal.md'), 'Inspect proposer changes');
  registry.registerOperation({
    id: 'comparison.application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    create: async () => ({
      execute: async (raw, context): Promise<JsonObject> => {
        const input = object(raw);
        if (input.action === 'initialize') {
          const ref = await context.artifacts.putJson({
            kind: 'file-tree',
            files: [
              {
                path: 'asset.md',
                mode: 0o644,
                base64: Buffer.from('baseline').toString('base64'),
              },
            ],
          });
          return {
            action: 'initialize',
            target: {},
            capabilities: [],
            initialCandidateRef: await context.recordCandidate(ref, null),
          };
        }
        assert.equal(input.action, 'commit');
        const workspace = await context.workspaces.read(string(input.editRef));
        const ref = await context.artifacts.capture(workspace.directory);
        return {
          action: 'commit',
          status: 'created',
          candidateRef: await context.recordCandidate(
            ref,
            string(input.parentCandidateRef),
          ),
          diffRef: await context.artifacts.putJson({
            text: `actual candidate patch: ${await readFile(join(workspace.directory, 'asset.md'), 'utf8')}`,
          }),
        };
      },
      dispose: async () => {},
    }),
  });
  let proposals = 0,
    reflections = 0;
  const reflectionProjects: string[] = [];
  registry.registerOperation({
    id: 'comparison.agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    create: async () => ({
      execute: async (raw, context) => {
        const request = object(raw);
        await context.charge('modelCalls', 1);
        if (string(request.message).includes('Inspect proposer changes')) {
          reflections++;
          reflectionProjects.push(string(request.cwd));
          return {
            edits:
              reflections === 1
                ? [
                    {
                      path: 'resources/proposer/prompt',
                      content: 'Inspect source asset before editing.',
                    },
                  ]
                : [],
            reason: 'Controlled resource comparison',
          };
        }
        proposals++;
        if (proposals === 2)
          assert.match(
            await readFile(join(string(request.cwd), 'AGENTS.md'), 'utf8'),
            /Inspect source asset before editing/,
          );
        context.event.emit('rsi/agent-observation', {
          runId: 'main',
          event: {
            type: 'tool.completed',
            toolCallId: 'source-read',
            name: 'read_file',
            status: 'succeeded',
            output: {
              path: 'asset.md',
              result: await readFile(
                join(string(request.cwd), 'candidate', 'asset.md'),
                'utf8',
              ),
              observation: 'actual captured source read',
            },
          },
        });
        return {
          edits: [
            {
              op: 'replace',
              path: 'asset.md',
              content: `candidate revision ${proposals}`,
            },
          ],
          reason: `proposed revision ${proposals}`,
        };
      },
      dispose: async () => {},
    }),
  });
  await writeFile(
    join(directory, 'reflection.yaml'),
    JSON.stringify({
      trigger: { on: 'loop-iteration' },
      evidence: { includeBindings: ['proposer'] },
      targets: { include: { proposer: ['prompt'] } },
      goal: './goal.md',
      implementation: {
        ref: 'reflection.agent',
        config: { agentRef: 'agent' },
      },
    }),
  );
  const call = (id: string, parent: string) => ({
    type: 'invoke',
    id,
    use: 'proposer',
    with: { parent, goal: 'Create the next candidate', evidenceRefs: [] },
  });
  await writeFile(
    join(directory, 'policy.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'comparison.policy',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        proposer: { contract: 'contract.proposer' },
        agent: { contract: agentContract.id },
      },
      defaults: {
        memory: false,
        reflection: { configFile: './reflection.yaml' },
        bindings: {
          proposer: {
            plugin: 'proposer.agent',
            config: {
              prompt: './proposer.md',
              agentRef: 'agent',
            },
          },
          agent: { plugin: 'comparison.agent', config: {} },
        },
      },
      output: {},
      steps: [
        {
          id: 'round',
          type: 'loop',
          maxIterations: 2,
          steps: [call('propose', '${{ application.initialCandidate }}')],
        },
      ],
    }),
  );
  registry.registerPolicy('comparison.policy', join(directory, 'policy.yaml'));
  await writeFile(
    join(directory, 'recipe.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'comparison',
      application: { plugin: 'comparison.application', config: {} },
      policy: { id: 'comparison.policy', config: {}, input: {} },
      budget: { operations: 100, modelCalls: 10, elapsedWallMs: 30000 },
    }),
  );
  const result = await manager.run(join(directory, 'recipe.yaml'), {
    id: 'comparison',
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(
    (await manager.facts.list('evolution-runs')).some(
      (run) => run.status === 'no-change',
    ),
  );
  assert.equal(reflections, 2);
  assert.deepEqual(await manager.facts.list('measurements'), []);
  const cwd = reflectionProjects[1]!;
  const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && entry.parentPath !== cwd,
  );
  const body = (
    await Promise.all(
      files.map((file) => readFile(join(file.parentPath, file.name), 'utf8')),
    )
  ).join('\n');
  assert.match(body, /actual candidate patch: candidate revision 2/);
  assert.match(body, /actual captured source read/);
  assert.match(body, /Use the current evidence to propose a concrete edit/);
  assert.match(body, /retrospective-comparison/);
  assert.match(body, /Inspect source asset before editing/);
  assert.ok(files.some((file) => file.name.endsWith('-difference.patch')));
  const calls = (await manager.facts.list('calls')).filter(
    (record) => record.bindingId === 'proposer',
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls.filter((record) => typeof record.revisionRef === 'string').length,
    1,
  );
});
