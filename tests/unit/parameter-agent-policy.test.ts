import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  applicationContract,
  inferencebenchContract,
  type JsonObject,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { object } from '../../src/shared/json.js';

test('parameter.agent loads default learning resources with either Reflection switch value', async (t) => {
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
  assert.ok(standard.reflection);
  const guidance = standard.bindings.proposer!.config.guidance;
  assert.equal(typeof guidance, 'string');
  assert.match(
    await readFile(join(String(guidance), 'search.md'), 'utf8'),
    /Configuration search guidance/,
  );
  for (const reflection of [false, true]) {
    declaration.policy.config = { reflection };
    const loaded = await Recipe.fromJSON(declaration, registry, options);
    assert.ok(loaded.reflection);
    const reloaded = await Recipe.fromJSON(loaded.toJSON(), registry, options);
    assert.deepEqual(reloaded.reflection, loaded.reflection);
  }
  declaration.policy.config = { reflection: false };
  const missingGuidance = {
    ...declaration,
    bindings: {
      ...declaration.bindings,
      proposer: { config: { guidance: './missing-guidance' } },
    },
  };
  await assert.rejects(
    Recipe.fromJSON(missingGuidance, registry, options),
    /guidance.*cannot read resource/,
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
        config: { maxTrials: 3, candidatesPerRound: 2 },
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
            if (input.parent === 'progress') {
              assert.equal(input.maxCandidates, 1);
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
            throw new Error('Unexpected extra proposal');
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
    ]);
    assert.equal(result.status, 'no-feasible-configuration');
    assert.equal(result.candidateFeasible, false);
    assert.equal(result.memoryRef, null);
    assert.equal(result.stopReason, 'max-trials');
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

test('parameter.agent continues empty proposals without a trial cap until cancelled', async () => {
  const registry = new Registry();
  const abort = new AbortController();
  const stopped = new Error('Experiment cancelled');
  let proposals = 0;
  let evaluations = 0;
  try {
    await registerBuiltins(registry);
    const policy = await Policy.load(
      registry.policy('parameter.agent'),
      registry,
    );
    await assert.rejects(
      policy.execute({
        context: new RuntimeContext().extend({ signal: abort.signal }),
        application: {},
        checkpoint: async () => {},
        input: { candidateRef: 'baseline' },
        config: { maxTrials: null, candidatesPerRound: 2 },
        async invoke(binding, raw): Promise<JsonObject> {
          const input = object(raw);
          if (binding === 'evaluator') {
            evaluations++;
            return { measurementRef: `m-${input.candidateRef}` };
          }
          if (binding === 'selector')
            return {
              accepted: true,
              candidateFeasible: true,
              selectedCandidateRef:
                evaluations === 1 ? 'baseline' : 'candidate',
              measurementRef: input.candidateMeasurementRef,
              reason: 'Measured improvement',
              decisionRef: 'decision',
              metric: 'score',
              incumbentValue: 1,
              candidateValue: 2,
              selectedValue: 2,
            };
          assert.equal(binding, 'proposer');
          proposals++;
          assert.equal(input.maxCandidates, 2);
          const previous = object(input.observations).previousNoChangeReason;
          if (proposals === 2) {
            assert.equal(previous, 'Research another mechanism');
            return {
              status: 'created',
              candidateRef: 'candidate',
              diffRef: 'diff',
              rationale: 'A testable change',
            };
          }
          if (proposals === 3) {
            assert.equal(input.parent, 'candidate');
            assert.equal(previous, null);
          }
          if (proposals === 4) {
            assert.equal(input.parent, 'candidate');
            assert.equal(previous, 'Research another mechanism');
            abort.abort(stopped);
          }
          return {
            status: 'no-change',
            candidateRef: input.parent,
            diffRef: null,
            rationale: 'Research another mechanism',
          };
        },
      }),
      (error: unknown) => error === stopped,
    );
    assert.equal(proposals, 4);
    assert.equal(evaluations, 2);
  } finally {
    await registry.dispose();
  }
});
