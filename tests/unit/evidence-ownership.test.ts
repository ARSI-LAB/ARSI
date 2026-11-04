import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type {
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import {
  applicationContract,
  defineContract,
} from '../../src/contracts/index.js';
import { typedArtifact } from '../../src/contracts/models/measurement.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { collectReflectionEvidence } from '../../src/runtime/revisions/evidence.js';
import { object, string } from '../../src/shared/json.js';
for (const consumer of ['Manager', 'Reflection'] as const) {
  test(`${consumer} uses Measurement ownership without visibility metadata`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-evidence-ownership-'));
    const registry = new Registry();
    const manager = new Manager({ registry, rootDirectory: root });
    const driver: OperationDefinition = {
      id: 'test.reader',
      contract: defineContract({
        id: 'contract.test-reader',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
      }),
      configSchema: { type: 'object' },
      async create(_config, services) {
        return {
          async execute(_input, context) {
            const payload = typedArtifact(
              'test.payload/v1',
              { type: 'object' },
              await services.artifacts.putJson({}),
            );
            const measurement: JsonObject = {
              schemaVersion: 'rsi.measurement/v1',
              ref: 'measurement-owned',
              experimentId: context.experimentId,
              callId: context.callId,
              candidateRef: 'candidate-test',
              evaluator: {
                pluginId: 'test.reader',
                implementationDigest: 'test',
              },
              startedAt: '2026-10-26T00:00:00Z',
              finishedAt: '2026-10-26T00:00:01Z',
              status: 'succeeded',
              coverage: 'complete',
              comparisonKey: null,
              conditions: payload,
              provenance: payload,
              profile: payload,
              extensions: [],
              diagnosticsRef: null,
              metrics: {},
              itemsRef: await services.artifacts.putJson({
                schemaVersion: 'rsi.measurement-items/v1',
                items: [],
              }),
              evidenceIndexRef: await services.artifacts.putJson({
                schemaVersion: 'rsi.measurement-evidence/v1',
                entries: [],
              }),
            };
            await services.facts.write(
              'measurements',
              'measurement-owned',
              measurement,
            );
            await services.facts.write('measurements', 'measurement-foreign', {
              ...measurement,
              ref: 'measurement-foreign',
              experimentId: 'another-experiment',
            });
            if (consumer === 'Manager') {
              const evidence = await context.readEvidence([
                'measurement-owned',
              ]);
              assert.equal(object(evidence).view, 'execution');
              assert.match(JSON.stringify(evidence), /measurement-owned/);
              await assert.rejects(
                context.readEvidence(['measurement-foreign']),
                /another experiment/,
              );
              await assert.rejects(
                context.readEvidence(['measurement-missing']),
                /ENOENT/,
              );
            } else {
              await services.facts.write('calls', 'owned-evaluation', {
                experimentId: context.experimentId,
                callId: 'owned-evaluation',
                bindingId: 'evaluator',
                parentCallId: 'root',
                path: 'loop/0/evaluate',
                status: 'succeeded',
                input: {
                  evidenceRefs: ['measurement-foreign', 'measurement-missing'],
                },
                output: { measurementRef: 'measurement-owned' },
                finishedAt: '2026-10-26T00:00:01Z',
              });
              const snapshot = await collectReflectionEvidence({
                context,
                names: ['evaluator'],
                identity: 'test-boundary',
                capturedAt: '2026-10-26T00:00:02Z',
                maxBytes: 16000,
              });
              assert.equal(snapshot.callCount, 1);
              const view = await services.facts.read(
                'evidence-views',
                string(snapshot.ref),
              );
              assert.deepEqual(view.measurementRefs, ['measurement-owned']);
              assert.match(
                JSON.stringify(object(view.index).diagnostics),
                /foreign-measurement|measurement-not-owned/,
              );
            }
            return {};
          },
          async dispose() {},
        };
      },
    };
    registry.registerOperation(driver);
    registry.registerOperation({
      ...driver,
      id: 'test.application',
      contract: applicationContract,
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
    try {
      await mkdir(join(root, 'baseline'));
      await writeFile(join(root, 'baseline/source.txt'), 'test');
      await writeFile(
        join(root, 'policy.yaml'),
        stringify({
          schemaVersion: 'rsi.policy/v1',
          id: 'test.policy',
          input_schema: { type: 'object' },
          output_schema: { type: 'object' },
          require: { reader: { contract: driver.contract.id } },
          output: '${{ steps.read.output }}',
          steps: [{ id: 'read', type: 'invoke', use: 'reader', with: {} }],
        }),
      );
      registry.registerPolicy('test.policy', join(root, 'policy.yaml'));
      await writeFile(
        join(root, 'recipe.yaml'),
        stringify({
          schemaVersion: 'rsi.recipe/v1',
          id: 'ownership',
          application: {
            plugin: 'test.application',
            config: {
              baseline: { directory: './baseline' },
              target: { schema: { type: 'object' } },
            },
          },
          policy: { id: 'test.policy', config: {}, input: {} },
          bindings: { reader: { plugin: driver.id, config: {} } },
          budget: { operations: 2, elapsedWallMs: 10000 },
        }),
      );
      await manager.run(join(root, 'recipe.yaml'), { id: 'ownership' });
    } finally {
      await manager.dispose();
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
