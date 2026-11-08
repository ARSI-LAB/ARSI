import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { runGepa } from '../fixtures/gepa-runtime.js';

test('a partially scored selection candidate cannot replace a complete mutation parent', async () => {
  const run = await runGepa({
    seed: 3,
    maxRounds: 2,
    maxRollouts: 30,
    feedbackTasks: ['f1', 'f2'],
    selectionTasks: ['s1', 's2'],
    scoreTable: {
      'A0|B0': { scores: { f1: 0.2, f2: 0.2, s1: 0.5, s2: 0.5 } },
      'A1|B0': { scores: { f1: 0.9, f2: 0.9, s1: 1, s2: null } },
      'A0|B1': { scores: { f1: 0.8, f2: 0.8, s1: 0.6, s2: 0.6 } },
      'A1|B1': { scores: { f1: 1, f2: 1, s1: 1, s2: 1 } },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const rounds = run.output.rounds as JsonObject[];
    assert.equal(rounds[0]!.status, 'evaluation-failed');
    assert.equal(rounds[1]!.status, 'admitted');
    assert.deepEqual(rounds[1]!.parentRefs, [run.output.baselineCandidateRef]);
    assert.deepEqual(run.evaluationCalls[4]!.files, {
      'a.md': 'A0',
      'b.md': 'B0',
    });
    assert.equal(run.output.bestAggregateScore, 0.6);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('repeating an admitted edit retains one population record and its original lineage', async () => {
  const run = await runGepa({
    seed: 1,
    maxRounds: 3,
    maxRollouts: 40,
    feedbackTasks: ['f1', 'f2'],
    selectionTasks: ['s1', 's2'],
    scoreTable: {
      'A0|B0': { scores: { f1: 0.2, f2: 0.2, s1: 1, s2: 0.5 } },
      'A1|B0': { scores: { f1: 0.9, f2: 0.9, s1: 0.5, s2: 1 } },
    },
    proposals: { a: 'A1', b: 'B0' },
  });
  try {
    const candidates = run.output.candidates as JsonObject[];
    const rounds = run.output.rounds as JsonObject[];
    assert.deepEqual(
      rounds.map((round) => round.status),
      ['admitted', 'no-change', 'rejected'],
    );
    assert.equal(rounds[2]!.candidateRef, rounds[0]!.candidateRef);
    assert.match(String(rounds[2]!.reason), /already in the population/);
    assert.equal(candidates.length, 2);
    assert.equal(new Set(candidates.map((candidate) => candidate.ref)).size, 2);
    const child = candidates.find(
      (candidate) => candidate.ref === rounds[0]!.candidateRef,
    )!;
    assert.equal(child.createdRound, 0);
    assert.deepEqual(child.parents, [run.output.baselineCandidateRef]);
    assert.deepEqual(child.ancestors, [run.output.baselineCandidateRef]);
    assert.equal(run.evaluationCalls.length, 7);
    assert.equal(run.output.rolloutsUsed, 14);
    assert.equal(run.output.completedRounds, 2);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});
