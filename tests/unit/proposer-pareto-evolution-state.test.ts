import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { paretoEvolutionPlanSchema } from '../../src/plugins/proposer-pareto-evolution/state.js';
import { createParetoEvolutionProposer } from '../../src/plugins/proposer-pareto-evolution/service.js';
import type { ParetoEvolutionConfig } from '../../src/plugins/proposer-pareto-evolution/schema.js';
import { validate } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';

const settings: ParetoEvolutionConfig = {
  maxRounds: 2,
  maxRollouts: 0,
  minibatchSize: 1,
  paretoSize: 1,
  seed: 11,
  crossoverEvery: 3,
  modules: [{ id: 'prompt', path: 'prompt.md' }],
  goal: 'Improve the prompt',
};

const taskPools = {
  feedbackTaskIds: ['feedback'],
  selectionTaskIds: ['selection'],
};

async function scope(t: TestContext): Promise<RuntimeContext> {
  const directory = await mkdtemp(
    join(tmpdir(), 'proposer-pareto-evolution-state-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new RuntimeContext().extend({
    signal: new AbortController().signal,
    experimentId: 'experiment',
    bindingId: 'population',
    artifacts: new FileArtifacts(directory),
    async readCandidate(ref: string) {
      return {
        ref,
        artifactRef: 'artifact:baseline',
        parentRef: null,
        experimentId: 'experiment',
      };
    },
  });
}

test('Pareto evolution proposer round plans reject incomplete reports and candidate records', () => {
  const plan = {
    report: {
      round: 0,
      strategy: 'mutation',
      status: 'rejected',
      parentRefs: ['parent'],
      ancestorRef: null,
      moduleIds: ['prompt'],
      taskIds: ['task'],
      parentScores: [],
      proposalScores: [],
      candidateRef: null,
      selectionScores: {},
      rollouts: 0,
      reason: '',
    },
    proposalInput: null,
    proposalResult: null,
    candidate: null,
  };
  validate(paretoEvolutionPlanSchema, plan);
  assert.throws(
    () => validate(paretoEvolutionPlanSchema, { ...plan, report: {} }),
    /data\/report must have required property/,
  );
  assert.throws(
    () => validate(paretoEvolutionPlanSchema, { ...plan, candidate: {} }),
    /data\/candidate must have required property/,
  );
});

test('Pareto evolution proposer state references restore into a fresh implementation and retain earlier snapshots', async (t) => {
  const context = await scope(t);
  const proposer = await createParetoEvolutionProposer(settings, context);
  const initial = await proposer.execute(
    { action: 'initialize', parent: 'baseline', ...taskPools },
    context,
  );
  const saved = await context.artifacts.readJson(initial.stateRef);
  assert.equal(
    object(saved).schemaVersion,
    'rsi.proposer-pareto-evolution-snapshot/v1',
  );
  assert.equal(
    object(object(saved).state).schemaVersion,
    'rsi.proposer-pareto-evolution-state/v1',
  );
  const restored = await createParetoEvolutionProposer(settings, context);
  const input = {
    action: 'observe' as const,
    stateRef: initial.stateRef,
    workId: 'initial',
    feedback: { kind: 'evaluation' as const, measurementRefs: [] },
  };
  await assert.rejects(
    restored.execute({ ...input, workId: 'other' }, context),
    /pending evaluation work/,
  );
  await assert.rejects(
    restored.execute(
      {
        ...input,
        feedback: { kind: 'evaluation', measurementRefs: ['unexpected'] },
      },
      context,
    ),
    /one measurement per requested evaluation/,
  );
  const observed = await restored.execute(input, context);
  assert.equal(observed.done, true);
  assert.notEqual(observed.stateRef, initial.stateRef);
  assert.deepEqual(await context.artifacts.readJson(initial.stateRef), saved);
  assert.deepEqual(await proposer.execute(input, context), observed);
});

test('Pareto evolution proposer rejects state references from another configuration or execution scope and malformed snapshots', async (t) => {
  const context = await scope(t);
  const proposer = await createParetoEvolutionProposer(settings, context);
  const initial = await proposer.execute(
    { action: 'initialize', parent: 'baseline', ...taskPools },
    context,
  );
  const input = { action: 'suggest' as const, stateRef: initial.stateRef };
  const changed = await createParetoEvolutionProposer(
    { ...settings, seed: 12 },
    context,
  );
  await assert.rejects(
    changed.execute(input, context),
    /configuration or execution scope mismatch/,
  );
  for (const foreign of [
    context.extend({ experimentId: 'other' }),
    context.extend({ bindingId: 'other' }),
  ])
    await assert.rejects(
      proposer.execute(input, foreign),
      /configuration or execution scope mismatch/,
    );
  const malformed = object(await context.artifacts.readJson(initial.stateRef));
  delete object(malformed.state).rng;
  const stateRef = await context.artifacts.putJson(malformed);
  await assert.rejects(
    proposer.execute({ ...input, stateRef }, context),
    /required property 'rng'/,
  );
});

test('Pareto evolution proposer retries an unconfirmed snapshot write with the same immutable state identity', async (t) => {
  const context = await scope(t);
  let failedRef = '';
  let fail = true;
  const interrupted = context.extend({
    artifacts: {
      async putJson(value: unknown): Promise<string> {
        const ref = await context.artifacts.putJson(value);
        if (fail) {
          fail = false;
          failedRef = ref;
          throw new Error('snapshot write outcome was unconfirmed');
        }
        return ref;
      },
      readJson: (ref: string) => context.artifacts.readJson(ref),
      capture: context.artifacts.capture.bind(context.artifacts),
      materialize: context.artifacts.materialize.bind(context.artifacts),
    },
  });
  const proposer = await createParetoEvolutionProposer(settings, interrupted);
  const input = {
    action: 'initialize' as const,
    parent: 'baseline',
    ...taskPools,
  };
  await assert.rejects(
    proposer.execute(input, interrupted),
    /snapshot write outcome was unconfirmed/,
  );
  const retried = await proposer.execute(input, interrupted);
  assert.equal(retried.stateRef, failedRef);
  assert.equal(retried.result, null);
  const saved = object(await context.artifacts.readJson(retried.stateRef));
  assert.equal(object(saved.state).rolloutsUsed, 0);
});
