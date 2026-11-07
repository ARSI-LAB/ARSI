import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { gepaPlanSchema } from '../../src/plugins/gepa/state.js';
import { createGepaSearch } from '../../src/plugins/gepa/service.js';
import type { GepaConfig } from '../../src/plugins/gepa/schema.js';
import { validate } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';

const settings: GepaConfig = {
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
  const directory = await mkdtemp(join(tmpdir(), 'gepa-search-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new RuntimeContext().extend({
    signal: new AbortController().signal,
    experimentId: 'experiment',
    bindingId: 'search',
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

test('GEPA round plans reject incomplete reports and candidate records', () => {
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
  validate(gepaPlanSchema, plan);
  assert.throws(
    () => validate(gepaPlanSchema, { ...plan, report: {} }),
    /data\/report must have required property/,
  );
  assert.throws(
    () => validate(gepaPlanSchema, { ...plan, candidate: {} }),
    /data\/candidate must have required property/,
  );
});

test('GEPA state references restore into a fresh implementation and retain earlier snapshots', async (t) => {
  const context = await scope(t);
  const search = await createGepaSearch(settings, context);
  const initial = await search.execute(
    { action: 'initialize', candidateRef: 'baseline', ...taskPools },
    context,
  );
  const saved = await context.artifacts.readJson(initial.stateRef);
  const restored = await createGepaSearch(settings, context);
  const input = {
    action: 'observe-initial' as const,
    stateRef: initial.stateRef,
    measurementRef: null,
  };
  const observed = await restored.execute(input, context);
  assert.equal(observed.done, true);
  assert.notEqual(observed.stateRef, initial.stateRef);
  assert.deepEqual(await context.artifacts.readJson(initial.stateRef), saved);
  assert.deepEqual(await search.execute(input, context), observed);
});

test('GEPA rejects state references from another configuration or execution scope and malformed snapshots', async (t) => {
  const context = await scope(t);
  const search = await createGepaSearch(settings, context);
  const initial = await search.execute(
    { action: 'initialize', candidateRef: 'baseline', ...taskPools },
    context,
  );
  const input = { action: 'prepare' as const, stateRef: initial.stateRef };
  const changed = await createGepaSearch({ ...settings, seed: 12 }, context);
  await assert.rejects(
    changed.execute(input, context),
    /configuration or execution scope mismatch/,
  );
  for (const foreign of [
    context.extend({ experimentId: 'other' }),
    context.extend({ bindingId: 'other' }),
  ])
    await assert.rejects(
      search.execute(input, foreign),
      /configuration or execution scope mismatch/,
    );
  const malformed = object(await context.artifacts.readJson(initial.stateRef));
  delete object(malformed.state).rng;
  const stateRef = await context.artifacts.putJson(malformed);
  await assert.rejects(
    search.execute({ ...input, stateRef }, context),
    /required property 'rng'/,
  );
});

test('GEPA retries an unconfirmed snapshot write with the same immutable state identity', async (t) => {
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
  const search = await createGepaSearch(settings, interrupted);
  const input = {
    action: 'initialize' as const,
    candidateRef: 'baseline',
    ...taskPools,
  };
  await assert.rejects(
    search.execute(input, interrupted),
    /snapshot write outcome was unconfirmed/,
  );
  const retried = await search.execute(input, interrupted);
  assert.equal(retried.stateRef, failedRef);
  assert.equal(retried.result, null);
  const saved = object(await context.artifacts.readJson(retried.stateRef));
  assert.equal(object(saved.state).rolloutsUsed, 0);
});
