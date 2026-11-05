import type { OptunaConfig } from '../../src/plugins/proposer-optuna/schema.js';
import { optunaProposerDefinition } from '../../src/plugins/proposer-optuna/index.js';
import { createOptunaProposer } from '../../src/plugins/proposer-optuna/service.js';
import test from 'node:test';
import { RuntimeContext } from '../../src/contracts/index.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { JsonObject } from '../../src/contracts/index.js';
import { gridProposerContract } from '../../src/contracts/plugin-types/proposer-grid.js';
import { inferencebenchContract } from '../../src/contracts/plugin-types/inferencebench.js';
import { metricSelectorContract } from '../../src/contracts/plugin-types/selector-metrics.js';
import { Policy } from '../../src/runtime/compiler/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';
import { applicationContract } from '../../src/contracts/plugin-types/application.js';
import {
  recordSchema,
  typedArtifact,
} from '../../src/contracts/models/measurement.js';
import { gridProposerDefinition } from '../../src/plugins/proposer-grid/index.js';
import {
  createFileApplication,
  type FileApplicationConfig,
} from '../../src/plugins/shared/file-application/files.js';
import { metricSelectorDefinition } from '../../src/plugins/selector-metrics/index.js';
import { Manager } from '../../src/runtime/manager/index.js';

test('autotune evaluates each grid point, adopts the first feasible point and retains ties across recovery', async () => {
  const registry = new Registry();
  try {
    registry.registerContract(gridProposerContract);
    registry.registerContract(inferencebenchContract);
    registry.registerContract(metricSelectorContract);
    const policy = await Policy.load(
      'src/policies/parameter-grid/policy.yaml',
      registry,
    );
    const evaluated: string[] = [];
    const proposed: number[] = [];
    const rates = [100, 12, 15, 15];
    let checkpoint: JsonObject = {};
    const options = {
      application: {},
      context: new RuntimeContext().extend({
        signal: new AbortController().signal,
      }),
      checkpoint: async (value: JsonObject) => {
        checkpoint = value;
      },

      invoke: async (name: string, raw: unknown): Promise<JsonObject> => {
        const input = object(raw);
        if (name === 'proposer') {
          assert.equal(input.parent, 'baseline');
          const cursor = Number(input.cursor);
          proposed.push(cursor);
          return {
            status: 'candidate',
            candidateRef: `c${cursor}`,
            nextCursor: cursor + 1,
            totalCandidates: 4,
            parameters: { arbitrary: cursor },
          };
        }
        if (name === 'evaluator') {
          evaluated.push(string(input.candidateRef));
          return { measurementRef: `m${string(input.candidateRef).slice(1)}` };
        }
        assert.equal(name, 'selector');
        const a = Number(string(input.incumbentMeasurementRef).slice(1));
        const b = Number(string(input.candidateMeasurementRef).slice(1));
        const accepted = b > 0 && rates[b]! > rates[a]!;
        return {
          accepted,
          candidateFeasible: b > 0,
          selectedCandidateRef: `c${accepted ? b : a}`,
          measurementRef: `m${accepted ? b : a}`,
          decisionRef: 'decision',
          reason: 'Compared.',
          metric: 'requestThroughput',
          incumbentValue: rates[a]!,
          candidateValue: rates[b]!,
          selectedValue: rates[accepted ? b : a]!,
        };
      },
    };
    const output = object(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxCandidates: 4 },
        ...options,
      }),
    );
    assert.deepEqual(proposed, [0, 1, 2, 3]);
    assert.deepEqual(evaluated, ['c0', 'c1', 'c2', 'c3']);
    assert.equal(output.candidateRef, 'c2');
    assert.equal(output.stopReason, 'search-exhausted');
    assert.deepEqual(output.parameters, { arbitrary: 2 });
    assert.deepEqual(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxCandidates: 4 },
        ...options,
        restore: checkpoint,
        invoke: async () => {
          throw new Error('Completed call repeated');
        },
      }),
      output,
    );
    const limited = object(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxCandidates: 1 },
        ...options,
      }),
    );
    assert.equal(limited.status, 'no-feasible-configuration');
    assert.equal(limited.candidateRef, null);
    assert.equal(limited.stopReason, 'max-candidates');
    proposed.length = 0;
    evaluated.length = 0;
    await assert.rejects(
      policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxCandidates: 4 },
        ...options,
        invoke: async (name, raw) => {
          if (name === 'selector')
            throw new Error('Interrupted before selection');
          return options.invoke(name, raw);
        },
      }),
      /Interrupted before selection/,
    );
    const resumed = object(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxCandidates: 4 },
        ...options,
        restore: checkpoint,
      }),
    );
    assert.equal(resumed.candidateRef, 'c2');
    assert.deepEqual(proposed, [0, 1, 2, 3]);
    assert.deepEqual(evaluated, ['c0', 'c1', 'c2', 'c3']);
  } finally {
    await registry.dispose();
  }
});

for (const strategy of ['grid', 'optuna'] as const) {
  test(`Runtime combines ${strategy}, Application commits and metric selection and resumes without repeating measurements`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-autotune-runtime-'));
    const registry = new Registry();
    const manager = new Manager({ registry, rootDirectory: root });
    let allInfeasible = false;
    let interruption: AbortController | undefined;
    let evaluationCount = 0;
    const evaluated: number[] = [];
    registry.registerOperation(gridProposerDefinition);
    registry.registerOperation({
      ...optunaProposerDefinition,
      create: (config: OptunaConfig, services) =>
        createOptunaProposer(config, services, async (_config, request) => ({
          environment: { python: '3.11', optuna: '4.5.0', numpy: '2.2.6' },
          ...(request.action === 'check'
            ? {}
            : {
                parameters: {
                  x: Array.isArray(request.history)
                    ? request.history.length
                    : 0,
                },
              }),
        })),
    });
    registry.registerOperation(metricSelectorDefinition);
    registry.registerOperation({
      id: 'test.application',
      contract: applicationContract,
      configSchema: { type: 'object' },
      create: (config: FileApplicationConfig, services) =>
        createFileApplication(config, services, {
          capability: 'inference-endpoint',
          verify: async () => ({}),
          acquire: async () => ({}),
          release: async () => {},
          dispose: async () => {},
        }),
    });
    registry.registerOperation({
      id: 'test.evaluator',
      contract: inferencebenchContract,
      configSchema: { type: 'object' },
      async create(_config, services) {
        return {
          async execute(raw, context) {
            const input = object(raw);
            const candidate = await context.readCandidate(
              string(input.candidateRef),
            );
            const workspace = await services.workspaces.create(
              candidate.artifactRef,
              candidate.ref,
            );
            let x: number;
            try {
              x = Number(
                object(
                  JSON.parse(
                    await readFile(
                      join(workspace.directory, 'tuning.json'),
                      'utf8',
                    ),
                  ),
                ).x,
              );
            } finally {
              await services.workspaces.release(workspace.ref);
            }
            evaluated.push(x);
            evaluationCount++;
            await context.charge('evaluationRuns', 1);
            const metadata = typedArtifact(
              'test.metadata/v1',
              recordSchema({ source: { type: 'string' } }),
              await services.artifacts.putJson({
                source: 'controlled benchmark',
              }),
            );
            const metric = async (
              id: string,
              unit: string,
              value: number,
            ): Promise<JsonObject> => ({
              definitionRef: await services.artifacts.putJson({
                id,
                description: id,
                unit,
                valueKind: 'scalar',
                version: 1,
                aggregation: 'single point',
                mapping: id,
              }),
              status: 'available',
              value: { kind: 'scalar', value },
              source: { artifactRef: metadata.artifactRef, pointer: '' },
            });
            const metrics = {
              requestThroughput: await metric(
                'requestThroughput',
                'req/s',
                [100, 12, 15, 15][x]!,
              ),
              sloSatisfied: await metric(
                'sloSatisfied',
                'ratio',
                !allInfeasible && x > 0 ? 1 : 0,
              ),
            };
            const evidenceIndexRef = await services.artifacts.putJson({
              schemaVersion: 'rsi.measurement-evidence/v1',
              entries: [],
            });
            const itemsRef = await services.artifacts.putJson({
              schemaVersion: 'rsi.measurement-items/v1',
              items: [
                {
                  id: 'load',
                  subject: {
                    kind: 'workload-point',
                    id: 'load',
                    parameters: null,
                  },
                  status: 'succeeded',
                  coverage: 'complete',
                  comparisonKey: 'fixed-load',
                  metrics,
                  evaluation: null,
                  evidenceIndexRef,
                  details: metadata,
                },
              ],
            });
            const measurementRef = await context.recordMeasurement({
              schemaVersion: 'rsi.measurement/v1',
              ref: 'pending',
              experimentId: context.experimentId,
              callId: context.callId,
              candidateRef: candidate.ref,
              evaluator: {
                pluginId: 'test.evaluator',
                implementationDigest: 'controlled-benchmark',
              },
              startedAt: '2026-10-26T00:00:00Z',
              finishedAt: '2026-10-26T00:00:01Z',
              status: 'succeeded',
              coverage: 'complete',
              comparisonKey: 'fixed-load',
              conditions: metadata,
              provenance: metadata,
              metrics,
              itemsRef,
              evidenceIndexRef,
              profile: metadata,
              diagnosticsRef: null,
              extensions: [],
            });
            interruption?.abort(new Error('Pause after measurement'));
            interruption = undefined;
            return { measurementRef };
          },
          async dispose() {},
        };
      },
    });
    registry.registerPolicy(
      `policy.parameter-${strategy}`,
      resolve(`src/policies/parameter-${strategy}/policy.yaml`),
    );
    const recipePath = join(root, 'recipe.yaml');
    const recipe = {
      schemaVersion: 'rsi.recipe/v1',
      id: 'test-autotune',
      application: {
        plugin: 'test.application',
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
                  description: 'parameters',
                  changes: ['modify'],
                },
              ],
            },
          },
        },
      },
      policy: {
        id: `policy.parameter-${strategy}`,
        config: strategy === 'grid' ? { maxCandidates: 4 } : { maxTrials: 4 },
      },
      bindings: {
        proposer: {
          plugin: `proposer.${strategy}`,
          config:
            strategy === 'grid'
              ? {
                  path: 'tuning.json',
                  searchSpace: [{ name: 'x', values: [0, 1, 2, 3] }],
                }
              : {
                  path: 'tuning.json',
                  sampler: { type: 'tpe' },
                  searchSpace: [
                    { name: 'x', distribution: 'int', low: 0, high: 3 },
                  ],
                },
        },
        evaluator: { plugin: 'test.evaluator', config: {} },
      },
      budget: { operations: 100, evaluationRuns: 10, elapsedWallMs: 30000 },
    };
    try {
      await mkdir(join(root, 'baseline'));
      await writeFile(
        join(root, 'baseline/tuning.json'),
        '{"x":0,"fixed":true}\n',
      );
      await writeFile(recipePath, stringify(recipe));
      const first = await manager.run(recipePath, { id: 'complete' });
      assert.equal(
        object(first.output).stopReason,
        strategy === 'grid' ? 'search-exhausted' : 'max-trials',
      );
      assert.deepEqual(object(first.output).parameters, { x: 2 });
      assert.deepEqual(evaluated, [0, 1, 2, 3]);
      assert.deepEqual(
        (await manager.run(recipePath, { id: 'complete', resume: true }))
          .output,
        first.output,
      );
      assert.equal(evaluationCount, 4);
      allInfeasible = true;
      const none = await manager.run(recipePath, { id: 'none' });
      assert.equal(object(none.output).status, 'no-feasible-configuration');
      assert.equal(object(none.output).candidateRef, null);
      allInfeasible = false;
      interruption = new AbortController();
      await assert.rejects(
        manager.run(recipePath, {
          id: 'interrupted',
          signal: interruption.signal,
        }),
        /Pause after measurement/,
      );
      const countAtPause = evaluationCount;
      const resumed = await manager.run(recipePath, {
        id: 'interrupted',
        resume: true,
      });
      assert.deepEqual(object(resumed.output).parameters, { x: 2 });
      assert.equal(evaluationCount, countAtPause + 3);
      await writeFile(
        recipePath,
        stringify({
          ...recipe,
          policy: {
            ...recipe.policy,
            config:
              strategy === 'grid' ? { maxCandidates: 2 } : { maxTrials: 2 },
          },
        }),
      );
      const capped = await manager.run(recipePath, { id: 'capped' });
      assert.equal(
        object(capped.output).stopReason,
        strategy === 'grid' ? 'max-candidates' : 'max-trials',
      );
      assert.deepEqual(object(capped.output).parameters, { x: 1 });
    } finally {
      await manager.dispose();
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
