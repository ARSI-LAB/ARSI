import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { runGepa } from '../fixtures/gepa-runtime.js';

const baseOptions = {
  seed: 11,
  maxRounds: 1,
  maxRollouts: 20,
  feedbackTasks: ['feedback-a'],
  selectionTasks: ['selection-a'],
  proposals: { a: 'A1' },
};
test('cancelled proposal measurement must not be counted as a completed rejected round', async () => {
  let run: Awaited<ReturnType<typeof runGepa>> | undefined;
  let terminal: JsonObject | undefined;
  let failure: unknown;
  try {
    try {
      run = await runGepa({
        ...baseOptions,
        scoreTable: {
          'A0|B0': { scores: { 'feedback-a': 0.2, 'selection-a': 0.2 } },
          'A1|B0': {
            scores: { 'feedback-a': 0.9, 'selection-a': 0.9 },
            status: 'cancelled',
          },
        },
        onFailure: async (value) => {
          terminal = value;
        },
      });
    } catch (error) {
      failure = error;
    }
    console.log(
      'CANCELLED_PROPOSAL_PROOF ' +
        JSON.stringify({
          terminal: terminal?.status,
          error: failure instanceof Error ? failure.message : null,
          completedRounds: run?.output.completedRounds,
          rounds: run?.output.rounds,
        }),
    );
    if (run) {
      assert.equal(run.output.completedRounds, 0);
      assert.ok(
        !(run.output.rounds as JsonObject[]).some(
          (round) => round.status === 'admitted' || round.status === 'rejected',
        ),
      );
    } else {
      assert.ok(failure);
      assert.notEqual(terminal?.status, 'succeeded');
    }
  } finally {
    if (run) {
      await run.manager.dispose();
      await rm(run.root, { recursive: true, force: true });
    }
  }
});
for (const kind of ['measurement', 'item', 'definition'] as const)
  test(
    'incompatible ' + kind + ' comparison keys must not admit a higher scalar',
    async () => {
      const change =
        kind === 'measurement'
          ? { comparisonKey: 'changed-conditions' }
          : kind === 'item'
            ? { itemComparisonKey: 'changed-item-conditions' }
            : { metricMapping: 'changed score definition' };
      const run = await runGepa({
        ...baseOptions,
        scoreTable: {
          'A0|B0': { scores: { 'feedback-a': 0.2, 'selection-a': 0.2 } },
          'A1|B0': {
            scores: { 'feedback-a': 0.9, 'selection-a': 0.9 },
            ...change,
          },
        },
      });
      try {
        console.log(
          'COMPARISON_KEY_PROOF ' +
            JSON.stringify({
              kind,
              completedRounds: run.output.completedRounds,
              candidateCount: (run.output.candidates as JsonObject[]).length,
              rounds: run.output.rounds,
            }),
        );
        assert.equal((run.output.candidates as JsonObject[]).length, 1);
        assert.notEqual(
          (run.output.rounds as JsonObject[])[0]!.status,
          'admitted',
        );
      } finally {
        await run.manager.dispose();
        await rm(run.root, { recursive: true, force: true });
      }
    },
  );

test('invalid module paths are rejected before paid evaluator side effects', async () => {
  let terminal: JsonObject | undefined;
  let unexpected: Awaited<ReturnType<typeof runGepa>> | undefined;
  let failure: unknown;
  try {
    try {
      unexpected = await runGepa({
        ...baseOptions,
        modules: [{ id: 'a', path: '../outside.md' }],
        scoreTable: {
          'A0|B0': { scores: { 'feedback-a': 0.2, 'selection-a': 0.2 } },
        },
        onFailure: async (snapshot) => {
          terminal = snapshot;
        },
      });
    } catch (error) {
      failure = error;
    }
    console.log(
      'EARLY_CONFIG_PROOF ' +
        JSON.stringify({
          error: failure instanceof Error ? failure.message : null,
          usage: terminal?.usage,
        }),
    );
    assert.ok(failure);
    assert.equal(object(terminal?.usage).evaluationRuns ?? 0, 0);
  } finally {
    if (unexpected) {
      await unexpected.manager.dispose();
      await rm(unexpected.root, { recursive: true, force: true });
    }
  }
});

for (const kind of ['measurement', 'item', 'definition'] as const)
  test(`selection ${kind} incompatibility must not improve the retained population`, async () => {
    const changed =
      kind === 'measurement'
        ? { comparisonKey: 'changed-selection-conditions' }
        : kind === 'item'
          ? { itemComparisonKey: 'changed-selection-item-conditions' }
          : { metricMapping: 'changed selection score definition' };
    const run = await runGepa({
      ...baseOptions,
      scoreTable: {
        'A0|B0': { scores: { 'feedback-a': 0.2, 'selection-a': 0.2 } },
        'A1|B0': {
          scores: { 'feedback-a': 0.9, 'selection-a': 0.9 },
          byTaskSet: {
            'selection-a': { scores: { 'selection-a': 0.9 }, ...changed },
          },
        },
      },
    });
    try {
      console.log(
        'SELECTION_COMPATIBILITY_PROOF ' +
          JSON.stringify({
            kind,
            bestAggregateScore: run.output.bestAggregateScore,
            candidates: run.output.candidates,
          }),
      );
      assert.equal(run.output.bestAggregateScore, 0.2);
      assert.ok(
        (run.output.candidates as JsonObject[]).every(
          (candidate) =>
            candidate.aggregate === 0.2 || candidate.aggregate === null,
        ),
      );
    } finally {
      await run.manager.dispose();
      await rm(run.root, { recursive: true, force: true });
    }
  });
