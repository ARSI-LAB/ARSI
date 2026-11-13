import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentContract,
  applicationContract,
  inferencebenchContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import {
  createFileApplication,
  type FileApplicationConfig,
} from '../../src/plugins/shared/file-application/files.js';
import { object, string } from '../../src/shared/json.js';
import { measurementFixture } from '../helpers/manager-fixture.js';

for (const customized of [false, true]) {
  test(`parameter.agent delivers ${customized ? 'scenario' : 'generic'} learning resources and resumes without replay`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-parameter-learning-'));
    const runtime = await createRuntime({
      rootDirectory: root,
      homeDirectory: false,
    });
    t.after(async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const reflectionGoal = customized
      ? '# Scenario reflection goal'
      : '# Improve configuration-search guidance';
    const events: string[] = [];
    let proposals = 0;
    let memories = 0;
    let reflections = 0;
    runtime.registry.registerOperation({
      id: 'learning.application',
      contract: applicationContract,
      configSchema: { type: 'object' },
      create: (config: FileApplicationConfig, services) =>
        createFileApplication(config, services, {
          capability: 'inference-endpoint',
          async verify(directory) {
            return object(
              JSON.parse(
                await readFile(join(directory, 'tuning.json'), 'utf8'),
              ),
            );
          },
          async acquire(_directory, parameters) {
            return parameters;
          },
          async release() {},
          async dispose() {},
        }),
    });
    runtime.registry.registerOperation({
      id: 'learning.evaluator',
      contract: inferencebenchContract,
      configSchema: { type: 'object' },
      async create() {
        return {
          async execute(input, context) {
            const candidateRef = string(object(input).candidateRef);
            return context.withInstance(
              candidateRef,
              'inference-endpoint',
              async (parameters) => {
                events.push(`evaluate:${parameters.batch}`);
                const measurement = await measurementFixture(context);
                return {
                  measurementRef: await context.recordMeasurement({
                    ...measurement,
                    candidateRef,
                    comparisonKey: 'fixed-workload',
                    metrics: {
                      score: {
                        ...object(object(measurement.metrics).score),
                        value: { kind: 'scalar', value: parameters.batch },
                      },
                    },
                  }),
                };
              },
            );
          },
          async dispose() {},
        };
      },
    });
    runtime.registry.registerOperation({
      id: 'learning.agent',
      contract: agentContract,
      configSchema: { type: 'object' },
      async create() {
        return {
          async execute(raw): Promise<JsonObject> {
            const request = object(raw);
            const cwd = string(request.cwd);
            const metadata = object(
              JSON.parse(
                await readFile(join(cwd, 'context/input.json'), 'utf8'),
              ),
            );
            const instructions = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
            if (string(request.goal).startsWith('Consolidate measured')) {
              assert.match(
                instructions,
                customized
                  ? /Scenario Memory instructions/
                  : /Maintain configuration-search experience/,
              );
              memories++;
              events.push('memory');
              assert.match(
                await readFile(join(cwd, 'context/measurements.json'), 'utf8'),
                /score/,
              );
              assert.ok(Array.isArray(object(metadata.observations).trials));
              if (memories === 2)
                throw new Error('Simulated Memory backend failure');
              return memories === 1
                ? {
                    edits: [
                      {
                        path: 'index.md',
                        content: 'Measured lesson: check graph coverage.',
                      },
                    ],
                    reason: 'Record evidence',
                  }
                : { edits: [], reason: 'Existing lesson remains sufficient' };
            }
            if (string(request.goal).includes(reflectionGoal)) {
              reflections++;
              events.push('reflection');
              assert.equal(metadata.evidenceView, 'training-summary');
              assert.match(
                await readFile(
                  join(cwd, 'context/reflection/index.json'),
                  'utf8',
                ),
                /proposer/,
              );
              return reflections === 1
                ? {
                    edits: [
                      {
                        path: 'bindings/proposer/resources/guidance/search.md',
                        content:
                          'Revised method: distinguish graph coverage from batch capacity.',
                      },
                    ],
                    reason: 'Improve hypothesis discrimination',
                  }
                : { edits: [], reason: 'No further guidance change' };
            }
            proposals++;
            events.push('propose');
            assert.match(
              instructions,
              customized
                ? /Research supported configuration changes/
                : /Propose configuration candidates/,
            );
            if (proposals === 1) {
              assert.equal(metadata.memory, null);
              assert.match(instructions, /Initial research method/);
              return {
                proposals: [
                  {
                    edits: [],
                    reason: 'Need a different supported mechanism.',
                  },
                ],
              };
            } else if (proposals === 2) {
              assert.equal(metadata.memory, null);
              assert.equal(
                object(metadata.observations).previousNoChangeReason,
                'Need a different supported mechanism.',
              );
              assert.match(
                instructions,
                /Revised method: distinguish graph coverage/,
              );
            } else {
              assert.equal(
                object(metadata.memory)['index.md'],
                'Measured lesson: check graph coverage.',
              );
              assert.match(
                instructions,
                /Revised method: distinguish graph coverage/,
              );
            }
            return {
              proposals: [
                {
                  edits: [
                    {
                      op: 'replace',
                      path: 'tuning.json',
                      content: JSON.stringify({ batch: proposals }),
                    },
                  ],
                  reason: 'Test a discriminating configuration',
                },
              ],
            };
          },
          async dispose() {},
        };
      },
    });
    await mkdir(join(root, 'baseline'));
    await mkdir(join(root, 'guidance'));
    await writeFile(join(root, 'baseline/tuning.json'), '{"batch":1}');
    await writeFile(
      join(root, 'guidance/search.md'),
      'Initial research method',
    );
    await writeFile(
      join(root, 'propose.md'),
      'Research supported configuration changes.',
    );
    await mkdir(join(root, 'scene'));
    await writeFile(
      join(root, 'scene/memory.md'),
      'Scenario Memory instructions',
    );
    await writeFile(join(root, 'scene/reflection.md'), reflectionGoal);
    await writeFile(
      join(root, 'scene/reflection.yaml'),
      `
evidence: [proposer, evaluator, selector, memoryUpdater]
targets:
  proposer: { resources: [guidance] }
goal: ./reflection.md
implementation:
  contract: contract.reflection
  ref: reflection.agent
  config: { agentRef: agent, evidenceView: training-summary }
`,
    );
    const recipe = join(root, 'recipe.json');
    await writeFile(
      recipe,
      JSON.stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'parameter-learning',
        application: {
          plugin: 'learning.application',
          config: {
            baseline: { directory: './baseline' },
            target: {
              schema: {
                schemaVersion: 'rsi.target/v1',
                id: 'parameters',
                entries: [
                  {
                    path: 'tuning.json',
                    kind: 'file',
                    description: 'Parameters',
                    changes: ['modify'],
                  },
                ],
              },
            },
          },
        },
        policy: {
          id: 'parameter.agent',
          config: {
            maxTrials: 3,
            candidatesPerRound: 1,
            memory: true,
            reflection: true,
          },
        },
        ...(customized
          ? { reflection: { configFile: './scene/reflection.yaml' } }
          : {}),
        bindings: {
          ...(customized
            ? { memoryUpdater: { config: { prompt: './scene/memory.md' } } }
            : {}),
          agent: { plugin: 'learning.agent' },
          proposer: {
            config: {
              ...(customized ? { prompt: './propose.md' } : {}),
              guidance: './guidance',
              evidenceView: 'training-summary',
            },
          },
          evaluator: { plugin: 'learning.evaluator' },
          selector: { config: { metric: 'score' } },
        },
      }),
    );
    const result = await runtime.manager.run(recipe, { id: 'learning' });
    assert.equal(result.status, 'succeeded');
    const output = object(result.output);
    assert.equal(typeof output.memoryRef, 'string');
    assert.notEqual(output.candidateRef, output.baselineCandidateRef);
    assert.deepEqual(events, [
      'evaluate:1',
      'propose',
      'reflection',
      'propose',
      'evaluate:2',
      'memory',
      'reflection',
      'propose',
      'evaluate:3',
      'memory',
      'reflection',
      'propose',
      'evaluate:4',
      'memory',
    ]);
    assert.equal(
      await readFile(join(root, 'guidance/search.md'), 'utf8'),
      'Initial research method',
    );
    const calls = await runtime.manager.facts.list('calls');
    const proposerCalls = calls.filter((call) => call.bindingId === 'proposer');
    assert.equal(proposerCalls.length, 4);
    const initial = proposerCalls.find(
      (call) => object(call.output).status === 'no-change',
    );
    assert.ok(initial);
    const subsequent = proposerCalls.filter((call) => call !== initial);
    assert.notEqual(initial.revisionRef, subsequent[0]!.revisionRef);
    assert.equal(subsequent[0]!.revisionRef, subsequent[1]!.revisionRef);
    const memoryCalls = calls.filter(
      (call) => call.bindingId === 'memoryUpdater',
    );
    const updated = memoryCalls.find(
      (call) => object(call.output).status === 'updated',
    );
    const failed = memoryCalls.find(
      (call) => object(call.output).status === 'failed',
    );
    assert.ok(updated);
    assert.ok(failed);
    const previous = object(updated.output).memoryRef;
    assert.equal(object(failed.output).memoryRef, previous);
    assert.equal(output.memoryRef, previous);
    const resumed = await runtime.manager.run(recipe, {
      id: 'learning',
      resume: true,
    });
    assert.deepEqual(resumed.output, result.output);
    assert.equal(
      (await runtime.manager.facts.list('calls')).length,
      calls.length,
    );
  });
}
