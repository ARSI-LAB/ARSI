import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  applicationContract,
  inferencebenchContract,
  proposerContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

test('parameter.agent leaves guidance unset and accepts custom Proposers when Reflection is disabled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-parameter-defaults-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await registerBuiltins(registry);
  for (const [id, contract] of [
    ['custom.application', applicationContract],
    ['custom.evaluator', inferencebenchContract],
    ['custom.proposer', proposerContract],
  ] as const) {
    registry.registerOperation({
      id,
      contract,
      configSchema: { type: 'object', additionalProperties: false },
      async create() {
        throw new Error('Loading must not execute plugins');
      },
    });
  }
  await writeFile(join(root, 'prompt.md'), 'User supplied prompt');
  const declaration = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'parameter-defaults',
    application: { plugin: 'custom.application' },
    policy: { id: 'parameter.agent', config: {} as JsonObject },
    bindings: {
      proposer: { config: { prompt: './prompt.md' } },
      evaluator: { plugin: 'custom.evaluator' },
    },
  };
  const options = { sourcePath: join(root, 'recipe.yaml') };
  const standard = await Recipe.fromJSON(declaration, registry, options);
  assert.equal(standard.policyConfig.memory, false);
  assert.equal(standard.policyConfig.reflection, false);
  assert.equal(
    standard.bindings.proposer!.config.prompt,
    join(root, 'prompt.md'),
  );
  assert.equal(standard.bindings.proposer!.config.guidance, undefined);
  assert.equal(standard.reflection, undefined);
  const custom = {
    ...declaration,
    bindings: {
      ...declaration.bindings,
      proposer: { plugin: 'custom.proposer' },
    },
  };
  for (const memory of [false, true]) {
    custom.policy.config = { memory };
    const loaded = await Recipe.fromJSON(custom, registry, options);
    assert.equal(loaded.reflection, undefined);
    assert.deepEqual(loaded.bindings.proposer!.config, {});
    const reloaded = await Recipe.fromJSON(loaded.toJSON(), registry, options);
    assert.equal(reloaded.reflection, undefined);
  }
  custom.policy.config = { reflection: true };
  await assert.rejects(
    Recipe.fromJSON(custom, registry, options),
    /Resource guidance is not declared/,
  );
});

test('parameter.agent follows selector decisions and returns the measured incumbent before constraints are met', async () => {
  const registry = new Registry();
  try {
    await registerBuiltins(registry);
    const policy = await Policy.load(
      registry.policy('parameter.agent'),
      registry,
    );
    const events: string[] = [];
    const result = object(
      await policy.execute({
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        application: {},
        checkpoint: async () => {},
        input: { candidateRef: 'baseline' },
        config: { maxTrials: 4, candidatesPerRound: 2 },
        async invoke(binding, raw): Promise<JsonObject> {
          const input = object(raw);
          events.push(
            `${binding}:${input.candidateRef ?? input.parent ?? input.candidateMeasurementRef}`,
          );
          if (binding === 'evaluator') {
            return { measurementRef: `m-${input.candidateRef}` };
          }
          if (binding === 'proposer') {
            assert.equal(input.memoryRef, null);
            if (input.parent === 'baseline') {
              assert.equal(input.maxCandidates, 2);
              assert.deepEqual(input.evidenceRefs, ['m-baseline']);
              assert.deepEqual(input.sources, [{ candidateRef: 'baseline' }]);
              return {
                status: 'batch',
                candidates: [
                  {
                    candidateRef: 'rejected',
                    diffRef: 'rejected-diff',
                    rationale: 'Try a larger batch',
                  },
                  {
                    candidateRef: 'progress',
                    diffRef: 'progress-diff',
                    rationale: 'Try a smaller batch',
                  },
                ],
              };
            }
            if (input.maxCandidates === 2) {
              assert.equal(input.parent, 'progress');
              assert.deepEqual(input.evidenceRefs, [
                'm-baseline',
                'm-rejected',
                'm-progress',
              ]);
              return {
                status: 'created',
                candidateRef: 'single',
                diffRef: 'single-diff',
                rationale: 'Try one more parameter set',
              };
            }
            assert.equal(input.parent, 'single');
            assert.equal(input.maxCandidates, 1);
            assert.deepEqual(input.sources, [
              { candidateRef: 'baseline' },
              { candidateRef: 'rejected' },
              { candidateRef: 'progress' },
              { candidateRef: 'single' },
            ]);
            assert.match(
              JSON.stringify(input.observations),
              /Constraints improved/,
            );
            return {
              status: 'no-change',
              candidateRef: 'single',
              diffRef: null,
              rationale: 'No untried options',
            };
          }
          assert.equal(binding, 'selector');
          const candidate = String(input.candidateMeasurementRef).slice(2);
          const accepted = ['progress', 'single'].includes(candidate);
          assert.equal(
            input.incumbentMeasurementRef,
            candidate === 'single' ? 'm-progress' : 'm-baseline',
          );
          const selected = accepted ? candidate : 'baseline';
          return {
            accepted,
            candidateFeasible: candidate === 'rejected',
            selectedCandidateRef: selected,
            reason: accepted ? 'Constraints improved' : 'Retain incumbent',
            decisionRef: 'decision',
            measurementRef: `m-${selected}`,
            metric: 'requestThroughput',
            incumbentValue: 10,
            candidateValue: 9,
            selectedValue: 10,
          };
        },
      }),
    );
    assert.deepEqual(events, [
      'evaluator:baseline',
      'selector:m-baseline',
      'proposer:baseline',
      'evaluator:rejected',
      'selector:m-rejected',
      'evaluator:progress',
      'selector:m-progress',
      'proposer:progress',
      'evaluator:single',
      'selector:m-single',
      'proposer:single',
    ]);
    assert.equal(result.status, 'no-feasible-configuration');
    assert.equal(result.candidateFeasible, false);
    assert.equal(result.memoryRef, null);
    assert.equal(result.stopReason, 'no-change');
    assert.equal(result.baselineCandidateRef, 'baseline');
    assert.equal(result.baselineMeasurementRef, 'm-baseline');
    assert.equal(result.candidateRef, 'single');
    assert.equal(result.measurementRef, 'm-single');
    assert.ok(Array.isArray(result.trials));
    assert.deepEqual(
      result.trials.map((trial) => object(trial).accepted),
      [false, true, true],
    );
    assert.deepEqual(
      result.trials.map((trial) => object(trial).candidateFeasible),
      [true, false, false],
    );
  } finally {
    await registry.dispose();
  }
});
