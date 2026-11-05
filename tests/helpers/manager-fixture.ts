import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type {
  Binding,
  RuntimeContext,
  JsonObject,
  JsonValue,
  OperationDefinition,
} from '../../src/contracts/index.js';
import { typedArtifact } from '../../src/contracts/models/measurement.js';
import {
  applicationContract,
  defineContract,
} from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';

export async function managerFixture(
  execute: (context: RuntimeContext) => Promise<JsonValue>,
  options: {
    config?: JsonObject;
    budget?: Record<string, number>;
    plugins?: OperationDefinition[];
    bindings?: Record<string, Binding>;
    context?: RuntimeContext;
    policy?: JsonObject;
    initialize?(context: RuntimeContext): Promise<void>;
    disposeDriver?(): Promise<void>;
  } = {},
): Promise<{
  manager: Manager;
  run(): Promise<JsonObject>;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-manager-service-'));
  const registry = new Registry();
  const manager = new Manager({
    registry,
    rootDirectory: root,
    context: options.context,
  });
  try {
    registry.registerOperation({
      id: 'test.application',
      contract: applicationContract,
      configSchema: { type: 'object' },
      async create(_config, _context) {
        return {
          async execute(_input, context) {
            await options.initialize?.(context);
            const artifact = await context.artifacts.putJson({
              kind: 'file-tree',
              files: [],
            });
            return {
              action: 'initialize',
              target: {},
              capabilities: [],
              initialCandidateRef: await context.recordCandidate(
                artifact,
                null,
              ),
            };
          },
          async dispose() {},
        };
      },
    });
    const driver: OperationDefinition = {
      id: 'test.driver',
      contract: defineContract({
        id: 'contract.test-driver',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
      }),
      configSchema: { type: 'object' },
      async create(_config, _context) {
        return {
          execute: (_input, context) => execute(context),
          async dispose() {
            await options.disposeDriver?.();
          },
        };
      },
    };
    registry.registerOperation(driver);
    for (const plugin of options.plugins ?? [])
      registry.registerOperation(plugin);
    const bindings = {
      driver: { plugin: driver.id, config: options.config ?? {} },
      ...options.bindings,
    };
    const requirements: JsonObject = {
      driver: { contract: driver.contract.id },
    };
    for (const [key, binding] of Object.entries(options.bindings ?? {})) {
      requirements[key] = {
        contract: registry.get(binding.plugin).contract.id,
      };
    }
    await writeFile(
      join(root, 'policy.yaml'),
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.policy',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: requirements,
        steps: [{ id: 'drive', type: 'invoke', use: 'driver', with: {} }],
        output: '${{ steps.drive.output }}',
        ...options.policy,
      }),
    );
    registry.registerPolicy('test.policy', join(root, 'policy.yaml'));
    await writeFile(
      join(root, 'recipe.yaml'),
      stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'test',
        application: { plugin: 'test.application', config: {} },
        policy: { id: 'test.policy', config: {}, input: {} },
        bindings,
        budget: { operations: 20, elapsedWallMs: 10000, ...options.budget },
      }),
    );
    return {
      manager,
      run: () => manager.run(join(root, 'recipe.yaml'), { id: 'test' }),
      async dispose() {
        await manager.dispose();
        await registry.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function measurementFixture(
  context: RuntimeContext,
): Promise<JsonObject> {
  const sourceRef = await context.artifacts.putJson({
    text: 'execution trace '.repeat(2000),
  });
  const privateArtifact = typedArtifact(
    'test.private/v1',
    { type: 'object' },
    await context.artifacts.putJson({ privateValue: 'owned by plugin' }),
  );
  const evidenceIndexRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.measurement-evidence/v1',
    entries: [
      {
        id: 'trajectory',
        kind: 'trajectory',
        artifactRef: sourceRef,
        mediaType: 'application/json',
        sizeBytes: null,
        itemId: 'task',
        attemptId: null,
        access: 'execution',
        integrity: 'complete',
      },
    ],
  });
  const definitionRef = await context.artifacts.putJson({
    id: 'score',
    description: 'Test score',
    unit: 'ratio',
    valueKind: 'scalar',
    version: 1,
    aggregation: 'mean',
    mapping: 'test score',
  });
  const metrics = {
    score: {
      definitionRef,
      status: 'available',
      value: { kind: 'scalar', value: 0.75 },
      source: { artifactRef: sourceRef, pointer: '' },
    },
  };
  const itemsRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.measurement-items/v1',
    items: [
      {
        id: 'task',
        subject: { kind: 'task', id: 'task', parameters: privateArtifact },
        status: 'succeeded',
        coverage: 'complete',
        comparisonKey: null,
        metrics,
        evaluation: null,
        evidenceIndexRef,
        details: privateArtifact,
      },
    ],
  });
  return {
    schemaVersion: 'rsi.measurement/v1',
    ref: 'pending',
    experimentId: context.experimentId,
    callId: context.callId,
    candidateRef: 'candidate-test',
    evaluator: { pluginId: 'test.driver', implementationDigest: 'test' },
    startedAt: '2026-10-26T00:00:00Z',
    finishedAt: '2026-10-26T00:00:01Z',
    status: 'succeeded',
    coverage: 'complete',
    comparisonKey: null,
    conditions: privateArtifact,
    provenance: privateArtifact,
    profile: privateArtifact,
    extensions: [privateArtifact],
    metrics,
    itemsRef,
    evidenceIndexRef,
    diagnosticsRef: null,
  };
}
