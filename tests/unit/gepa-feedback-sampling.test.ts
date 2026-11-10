import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import {
  Rng,
  sampleFeedbackTasks,
  sampleWithoutReplacement,
  type RoundReport,
} from '../../src/plugins/proposer-pareto-evolution/engine.js';
import { configSchema } from '../../src/plugins/proposer-pareto-evolution/schema.js';
import { validate } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';
import { runGepa } from '../fixtures/gepa-runtime.js';

function report(tasks: string[], scores: (number | null)[]): RoundReport {
  return {
    round: 0,
    strategy: 'mutation',
    status: 'no-change',
    parentRefs: ['baseline'],
    ancestorRef: null,
    moduleIds: ['prompt'],
    taskIds: tasks,
    parentScores: scores,
    proposalScores: [],
    candidateRef: 'baseline',
    selectionScores: {},
    rollouts: tasks.length,
    reason: 'No changes',
  };
}

test('GEPA defaults to the existing random sequence and rejects invalid sampling modes', () => {
  const state = { feedbackTaskIds: ['a', 'b', 'c'], rounds: [] };
  for (const mode of [undefined, 'random'] as const) {
    const expected = new Rng(17);
    const actual = new Rng(17);
    assert.deepEqual(
      sampleFeedbackTasks(actual, state, {
        minibatchSize: 2,
        feedbackSampling: mode,
      }),
      sampleWithoutReplacement(expected, state.feedbackTaskIds, 2),
    );
    assert.equal(actual.state, expected.state);
  }
  assert.throws(
    () =>
      validate(configSchema, {
        maxRounds: 10,
        maxRollouts: 80,
        minibatchSize: 1,
        paretoSize: 5,
        seed: 17,
        crossoverEvery: 0,
        modules: [{ id: 'prompt', path: 'prompt.md' }],
        goal: 'Improve',
        feedbackSampling: 'unsupported',
      }),
    /feedbackSampling/,
  );
});

test('coverage-first counts finite parent scores, including zero and no-change, without batch duplicates', () => {
  const state = {
    feedbackTaskIds: ['zero', 'unknown', 'non-finite', 'other'],
    rounds: [
      report(
        ['zero', 'unknown', 'non-finite', 'other'],
        [0, null, Infinity, 1],
      ),
    ],
  };
  const settings = {
    minibatchSize: 2,
    feedbackSampling: 'coverage-first' as const,
  };
  assert.deepEqual(sampleFeedbackTasks(new Rng(17), state, settings).sort(), [
    'non-finite',
    'unknown',
  ]);
  const batch = sampleFeedbackTasks(new Rng(17), state, {
    ...settings,
    minibatchSize: 4,
  });
  assert.deepEqual(batch.slice(0, 2).sort(), ['non-finite', 'unknown']);
  assert.equal(new Set(batch).size, 4);
  state.rounds.push(report(['unknown', 'non-finite'], [0, 0]));
  const expected = new Rng(17);
  const actual = new Rng(17);
  assert.deepEqual(
    sampleFeedbackTasks(actual, state, settings),
    sampleWithoutReplacement(expected, state.feedbackTaskIds, 2),
  );
  assert.equal(actual.state, expected.state);
});

test('coverage-first runs ten single-task attempts and restores a pending parent evaluation without replay', async () => {
  const training = Array.from({ length: 10 }, (_, index) => `train-${index}`);
  const validation = Array.from(
    { length: 5 },
    (_, index) => `validation-${index}`,
  );
  const options: Parameters<typeof runGepa>[0] = {
    seed: 20261105,
    maxRounds: 10,
    maxRollouts: 80,
    minibatchSize: 1,
    paretoSize: 5,
    feedbackSampling: 'coverage-first',
    crossoverEvery: 0,
    feedbackTasks: training,
    selectionTasks: validation,
    baselineFiles: { 'a.md': 'A0' },
    modules: [{ id: 'a', path: 'a.md' }],
    scoreTable: {
      A0: {
        scores: Object.fromEntries(
          [...training, ...validation].map((task) => [task, 0]),
        ),
      },
    },
    proposals: { a: null },
  };
  const complete = await runGepa(options);
  let resumed: Awaited<ReturnType<typeof runGepa>> | undefined;
  try {
    resumed = await runGepa({
      ...options,
      resumeAfterEvaluation: 4,
      restartOnResume: true,
    });
    assert.deepEqual(resumed.output, complete.output);
    assert.deepEqual(resumed.evaluationCalls, complete.evaluationCalls);
    assert.deepEqual(
      (await resumed.manager.get('gepa-runtime')).usage,
      (await complete.manager.get('gepa-runtime')).usage,
    );
    const rounds = Array.isArray(complete.output.rounds)
      ? complete.output.rounds.map((round) => object(round))
      : [];
    assert.equal(rounds.length, 10);
    assert.equal(complete.output.completedRounds, 0);
    assert(rounds.every((round) => round.status === 'no-change'));
    assert(
      rounds.every(
        (round) =>
          Array.isArray(round.parentScores) && round.parentScores[0] === 0,
      ),
    );
    const sampled = complete.evaluationCalls
      .slice(1)
      .flatMap((call) => call.taskIds);
    assert.equal(new Set(sampled).size, 10);
    assert.deepEqual([...sampled].sort(), [...training].sort());
    assert.deepEqual(
      [...complete.evaluationCalls[0]!.taskIds].sort(),
      [...validation].sort(),
    );
    assert.equal(complete.evaluationCalls.length, 11);
  } finally {
    for (const run of [complete, resumed])
      if (run) {
        await run.manager.dispose();
        await rm(run.root, { recursive: true, force: true });
      }
  }
});
