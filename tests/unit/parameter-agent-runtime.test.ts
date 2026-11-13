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

test('Manager runs the Agent Policy with direct evaluation, bounded search, and no search after a failed baseline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-parameter-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await createRuntime({
    rootDirectory: root,
    homeDirectory: false,
  });
  const launches: number[] = [];
  const benchmarks: number[] = [];
  const releases: (number | null)[] = [];
  const candidateParents = new Map<string, string | null>();
  let modelCalls = 0;
  runtime.registry.registerOperation({
    id: 'test.parameter-application',
    contract: applicationContract,
    configSchema: { type: 'object' },
    create: (config: FileApplicationConfig, services) =>
      createFileApplication(config, services, {
        capability: 'inference-endpoint',
        async describeTarget() {
          return { parameterCatalog: { max_num_seqs: { kind: 'integer' } } };
        },
        async verify(directory) {
          return object(
            JSON.parse(await readFile(join(directory, 'tuning.json'), 'utf8')),
          );
        },
        async acquire(_directory, config) {
          const size = Number(config.max_num_seqs);
          launches.push(size);
          if (size === 32) throw new Error('NPU memory pressure');
          return { size };
        },
        async release(instance) {
          releases.push(
            instance.execution ? Number(object(instance.execution).size) : null,
          );
        },
        async dispose() {},
      }),
  });
  runtime.registry.registerOperation({
    id: 'test.parameter-evaluator',
    contract: inferencebenchContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, context) {
          const candidateRef = string(object(input).candidateRef);
          return context.withInstance(
            candidateRef,
            'inference-endpoint',
            async (execution) => {
              const size = Number(execution.size);
              await context.charge('evaluationRuns', 1);
              benchmarks.push(size);
              const measurement = await measurementFixture(context);
              const existingMetric = object(object(measurement.metrics).score);
              const definitionRef = await context.artifacts.putJson({
                id: 'requestThroughput',
                description: 'Mock request throughput',
                unit: 'requests/s',
                valueKind: 'scalar',
                version: 1,
                aggregation: 'single point',
                mapping: 'fixture',
              });
              return {
                measurementRef: await context.recordMeasurement({
                  ...measurement,
                  candidateRef,
                  comparisonKey: 'fixed-workload',
                  metrics: {
                    requestThroughput: {
                      ...existingMetric,
                      definitionRef,
                      value: { kind: 'scalar', value: size },
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
    id: 'test.parameter-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
      services.event.on('rsi/candidate-recorded', (event) => {
        candidateParents.set(event.candidateRef, event.parentRef);
      });
      return {
        async execute(input): Promise<JsonObject> {
          const cwd = string(object(input).cwd);
          modelCalls++;
          const instructions = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
          const metadata = await readFile(
            join(cwd, 'context/input.json'),
            'utf8',
          );
          assert.match(metadata, /parameterCatalog/);
          const current = JSON.parse(
            await readFile(join(cwd, 'candidate/tuning.json'), 'utf8'),
          );
          assert.match(instructions, /Optimize the scheduler/);
          assert.match(
            await readFile(join(cwd, 'sources/0/tuning.json'), 'utf8'),
            /"max_num_seqs":8/,
          );
          assert.match(
            await readFile(join(cwd, 'roles/scheduler.md'), 'utf8'),
            /Choose a batching change/,
          );
          assert.match(
            await readFile(join(cwd, 'context/measurements.json'), 'utf8'),
            /requestThroughput/,
          );
          assert.equal(current.max_num_seqs, 8);
          assert.equal(object(JSON.parse(metadata)).maxCandidates, 3);
          return {
            proposals: [
              {
                edits: [
                  {
                    op: 'replace',
                    path: 'tuning.json',
                    content: '{"max_num_seqs":16}',
                  },
                ],
                reason: 'Raise concurrency',
              },
              {
                edits: [
                  {
                    op: 'replace',
                    path: 'tuning.json',
                    content: '{ "max_num_seqs" : 8 }\n',
                  },
                ],
                reason: 'Repeat baseline with different formatting',
              },
              {
                edits: [
                  {
                    op: 'replace',
                    path: 'tuning.json',
                    content: '{"max_num_seqs":12}',
                  },
                ],
                reason: 'Try an intermediate value',
              },
            ],
          };
        },
        async dispose() {},
      };
    },
  });
  try {
    await mkdir(join(root, 'baseline'));
    await Promise.all([
      writeFile(join(root, 'baseline/tuning.json'), '{"max_num_seqs":32}'),
      writeFile(join(root, 'optimize.md'), 'Optimize the scheduler'),
      writeFile(join(root, 'scheduler.md'), 'Choose a batching change'),
    ]);
    const recipe = join(root, 'recipe.json');
    await writeFile(
      recipe,
      JSON.stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'test-parameter-agent',
        application: {
          plugin: 'test.parameter-application',
          config: {
            baseline: { directory: './baseline' },
            target: {
              schema: {
                schemaVersion: 'rsi.target/v1',
                id: 'test',
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
          config: { maxTrials: 3 },
        },
        bindings: {
          agent: { plugin: 'test.parameter-agent' },
          proposer: {
            config: {
              prompt: './optimize.md',
              evidenceView: 'training-summary',
              subagents: [
                {
                  name: 'scheduler',
                  description: 'Review scheduler settings',
                  prompt: './scheduler.md',
                },
              ],
            },
          },
          evaluator: { plugin: 'test.parameter-evaluator' },
        },
        budget: { evaluationRuns: 4, elapsedWallMs: 30000 },
      }),
    );
    await assert.rejects(
      runtime.manager.run(recipe, { id: 'bad-baseline' }),
      /NPU memory pressure/,
    );
    assert.deepEqual(launches, [32]);
    assert.deepEqual(benchmarks, []);
    assert.deepEqual(releases, [null]);
    assert.equal(modelCalls, 0);
    await writeFile(join(root, 'baseline/tuning.json'), '{"max_num_seqs":8}');
    launches.length = 0;
    releases.length = 0;

    const result = await runtime.manager.run(recipe, { id: 'tune' });
    assert.equal(result.status, 'succeeded');
    const output = object(result.output);
    assert.equal(output.status, 'selected');
    assert.equal(output.candidateFeasible, true);
    assert.equal(output.stopReason, 'max-trials');
    assert.notEqual(output.candidateRef, output.baselineCandidateRef);
    assert.deepEqual(launches, [8, 16, 8, 12]);
    assert.deepEqual(benchmarks, [8, 16, 8, 12]);
    assert.deepEqual(releases, [8, 16, 8, 12]);
    assert.equal(modelCalls, 1);
    assert.ok(Array.isArray(output.trials));
    const repeated = object(output.trials[1]);
    assert.equal(repeated.status, 'measured');
    assert.equal(repeated.accepted, false);
    assert.notEqual(repeated.candidateRef, output.baselineCandidateRef);
    assert.equal(output.candidateRef, object(output.trials[0]).candidateRef);
    for (const trial of output.trials)
      assert.equal(
        candidateParents.get(string(object(trial).candidateRef)),
        output.baselineCandidateRef,
      );

    const cappedRecipe = join(root, 'capped.json');
    const capped = object(JSON.parse(await readFile(recipe, 'utf8')));
    object(object(capped.policy).config).maxTrials = null;
    object(object(capped.policy).config).candidatesPerRound = 3;
    capped.budget = { ...object(capped.budget), evaluationRuns: 2 };
    await writeFile(cappedRecipe, JSON.stringify(capped));
    launches.length = 0;
    benchmarks.length = 0;
    releases.length = 0;
    modelCalls = 0;
    await assert.rejects(
      runtime.manager.run(cappedRecipe, { id: 'capped' }),
      /Budget exceeded: evaluationRuns/,
    );
    const stopped = await runtime.manager.get('capped');
    assert.equal(stopped.stopReason, 'budget-exhausted');
    assert.equal(stopped.budgetMetric, 'evaluationRuns');
    const partial = object(stopped.partialOutput);
    assert.equal(partial.stopReason, null);
    assert.equal(partial.status, 'selected');
    assert.ok(Array.isArray(partial.trials));
    assert.equal(partial.trials.length, 1);
    assert.equal(partial.candidateRef, object(partial.trials[0]).candidateRef);
    assert.equal(
      partial.measurementRef,
      object(partial.trials[0]).measurementRef,
    );
    assert.deepEqual(benchmarks, [8, 16]);
    assert.deepEqual(releases, launches);
  } finally {
    await runtime.dispose();
  }
});
