import { cp, mkdtemp, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import type { JsonObject } from '../../../src/contracts/index.js';
import type { Registry } from '../../../src/runtime/registry/index.js';

/** Adapter tests register their own small flows instead of adding production Policies. */
function measurementPolicy(diagnostic: boolean): JsonObject {
  const initial = '${{ steps.evaluate_baseline.output.measurementRef }}';
  return {
    schemaVersion: 'rsi.policy/v1',
    id: diagnostic ? 'test.operator-diagnostic' : 'test.operator-evaluation',
    config_schema: { type: 'object' },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    require: {
      evaluator: { contract: 'contract.operatorbench' },
      selector: { contract: 'contract.selector-metrics' },
    },
    steps: [
      {
        id: 'evaluate_baseline',
        type: 'invoke',
        use: 'evaluator',
        with: {
          action: 'evaluate',
          candidateRef: '${{ application.initialCandidate }}',
          caseIds: ['fixed'],
        },
      },
      {
        id: 'check_baseline',
        type: 'invoke',
        use: 'selector',
        with: {
          incumbentMeasurementRef: initial,
          candidateMeasurementRef: initial,
        },
      },
      ...(diagnostic
        ? [
            {
              id: 'profile_baseline',
              type: 'invoke',
              use: 'evaluator',
              with: {
                action: 'profile',
                candidateRef: '${{ application.initialCandidate }}',
                caseIds: ['fixed'],
                assessmentMeasurementRef: initial,
              },
            },
          ]
        : [
            {
              id: 'evaluate_final',
              type: 'invoke',
              use: 'evaluator',
              with: {
                action: 'evaluate',
                candidateRef: '${{ application.initialCandidate }}',
                caseIds: ['fixed'],
              },
            },
            {
              id: 'check_final',
              type: 'invoke',
              use: 'selector',
              with: {
                incumbentMeasurementRef: initial,
                candidateMeasurementRef:
                  '${{ steps.evaluate_final.output.measurementRef }}',
              },
            },
          ]),
    ],
    output: {
      bestCandidateRef: '${{ application.initialCandidate }}',
      bestMeasurementRef: initial,
      finalMeasurementRef: diagnostic
        ? null
        : '${{ steps.evaluate_final.output.measurementRef }}',
      finalDecisionRef: diagnostic
        ? null
        : '${{ steps.check_final.output.decisionRef }}',
      finalValidity: diagnostic
        ? 'not-run'
        : "${{ if(steps.check_final.output.candidateFeasible, 'valid', 'invalid') }}",
      stopReason: diagnostic ? 'diagnostic-only' : 'baseline-only',
      attempts: [],
      ...(diagnostic
        ? {
            diagnosticMeasurementRef:
              '${{ steps.profile_baseline.output.measurementRef }}',
            collectionStatus:
              '${{ steps.profile_baseline.output.collectionStatus }}',
          }
        : {}),
    },
  };
}

export function registerOperatorFixturePolicies(
  registry: Registry,
  root: string,
): void {
  for (const name of ['evaluation', 'diagnostic'])
    registry.registerPolicy(
      `test.operator-${name}`,
      join(root, `test-${name}.yaml`),
    );
}

export async function prepareOperatorFixture(): Promise<{
  root: string;
  recipePath: string;
  worker: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-operator-'));
  const example = join(root, 'example');
  await cp(
    new URL(
      '../../../examples/artifacts/kernel/transpose-copy/',
      import.meta.url,
    ),
    example,
    { recursive: true },
  );
  const worker = join(root, 'worker.mjs');
  await cp(new URL('./worker.mjs', import.meta.url), worker);
  await chmod(worker, 0o755);
  for (const diagnostic of [false, true])
    await writeFile(
      join(root, diagnostic ? 'test-diagnostic.yaml' : 'test-evaluation.yaml'),
      stringify(measurementPolicy(diagnostic)),
    );
  const recipePath = join(example, 'recipe.sdk.fixture.yaml');
  await writeFile(
    recipePath,
    stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'operator-evaluation-fixture',
      application: {
        plugin: 'application.kernel',
        config: {
          target: { schema: './target.yaml' },
          baseline: { directory: './baseline' },
        },
      },
      policy: { id: 'test.operator-evaluation', config: {} },
      bindings: {
        evaluator: {
          plugin: 'evaluator.operatorbench',
          config: {
            mode: 'sdk',
            task: { directory: './task' },
            protocol: {
              warmup: 5,
              repeat: 20,
              rtol: 0,
              atol: 0,
              timingScope: 'all-device-kernels',
            },
            sdk: {
              python: worker,
              device: 0,
              timeoutSeconds: 15,
              profiling: { enabled: false, cacheEnabled: false },
            },
          },
        },
        selector: {
          plugin: 'selector.metric',
          config: {
            metric: 'latencyMeanMs',
            direction: 'minimize',
            eligibility: [{ metric: 'candidateValid', min: 1 }],
          },
        },
      },
      budget: {
        operations: 30,
        evaluationRuns: 2,
        modelCalls: 0,
        elapsedWallMs: 2400000,
        cleanupReserveMs: 60000,
      },
    }),
  );
  return { root, recipePath, worker };
}
