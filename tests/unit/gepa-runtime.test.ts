import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { runGepa, decodeTree } from '../fixtures/gepa-runtime.js';

async function expectRunFailure(
  options: Parameters<typeof runGepa>[0],
  reason: RegExp,
  evaluations = 2,
  agents?: number,
): Promise<void> {
  let unexpected: Awaited<ReturnType<typeof runGepa>> | undefined;
  let status: unknown;
  let evaluationCount = -1;
  let agentCount = -1;
  try {
    await assert.rejects(async () => {
      unexpected = await runGepa({
        ...options,
        onFailure: async (snapshot, calls) => {
          status = snapshot.status;
          evaluationCount = calls.evaluationCalls.length;
          agentCount = calls.agentCalls.length;
        },
      });
    }, reason);
    assert.equal(status, 'failed');
    assert.equal(evaluationCount, evaluations);
    if (agents !== undefined) assert.equal(agentCount, agents);
  } finally {
    if (unexpected) {
      await unexpected.manager.dispose();
      await rm(unexpected.root, { recursive: true, force: true });
    }
  }
}

test('a custom Policy invokes evaluator and Proposer bindings directly', async () => {
  const run = await runGepa({
    seed: 11,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    bindingNames: { evaluator: 'measure', proposer: 'mutate', agent: 'revise' },
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0.2 } },
      'A1|B0': { scores: { 'task-a': 0.6 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    assert.equal(run.output.completedRounds, 1);
    assert.equal(run.output.bestAggregateScore, 0.6);
    assert.equal(run.output.rolloutsUsed, 4);
    assert.equal(run.evaluationCalls.length, 4);
    assert.equal(run.agentCalls.length, 1);
    assert.equal((run.output.rounds as JsonObject[])[0]!.status, 'admitted');
    const calls = await run.manager.facts.list('calls');
    const evolutionProposerCalls = new Set(
      calls
        .filter((call) => call.bindingId === 'evolutionProposer')
        .map((call) => call.callId),
    );
    assert.ok(evolutionProposerCalls.size > 0);
    for (const binding of ['measure', 'mutate']) {
      const externalCalls = calls.filter((call) => call.bindingId === binding);
      assert.equal(externalCalls.length, binding === 'measure' ? 4 : 1);
      for (const call of externalCalls) {
        assert.equal(evolutionProposerCalls.has(call.parentCallId), false);
        assert.match(String(call.path), /^steps\//);
      }
    }
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('a complete mutation round uses sampled evidence, admits strict improvement and stops at maxRounds', async () => {
  const run = await runGepa({
    seed: 11,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a', 'task-b'],
    selectionTasks: ['task-a', 'task-b'],
    scoreTable: {
      'A0|B0': {
        scores: { 'task-a': 0.2, 'task-b': 0.2 },
        marker: 'baseline-output',
      },
      'A1|B0': {
        scores: { 'task-a': 0.6, 'task-b': 0.6 },
        marker: 'improved-output',
      },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 1);
    assert.equal(output.rolloutsUsed, 8);
    assert.equal(output.maxRollouts, 20);
    assert.equal(output.bestCandidateRef !== null, true);
    assert.equal(output.bestAggregateScore, 0.6);
    assert.equal(run.evaluationCalls.length, 4);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.agentCalls[0]!.moduleId, 'a');
    const request = run.agentCalls[0]!;
    assert.deepEqual(Object.keys(request.request).sort(), [
      'cwd',
      'goal',
      'outputSchema',
    ]);
    assert.equal(request.evidence.view, 'training-summary');
    assert.deepEqual(object(request.metadata.editConstraints).allowedPaths, [
      'a.md',
    ]);
    assert.equal(object(request.metadata.editConstraints).maxChangedFiles, 1);
    const evidenceText = JSON.stringify(request.evidence);
    assert.match(evidenceText, /"value":0.2/);
    assert.match(evidenceText, /feedback for task-a/);
    assert.match(evidenceText, /TASK_INPUT_MARKER task-a/);
    assert.match(evidenceText, /AGENT_OUTPUT_MARKER baseline-output/);
    const measurements = request.evidence.measurements as JsonObject[];
    const items = measurements.flatMap(
      (measurement) => measurement.items as JsonObject[],
    );
    assert.deepEqual(items.map((item) => item.id).sort(), ['task-a', 'task-b']);
    assert.equal(request.metadata.executionEvidence, undefined);
    assert.deepEqual(Object.keys(request.candidateFiles).sort(), [
      'a.md',
      'b.md',
    ]);
    assert.deepEqual(Object.keys(request.projectFiles).sort(), [
      '.rsi-project',
      'AGENTS.md',
      'CLAUDE.md',
      'candidate/a.md',
      'candidate/b.md',
      'context/input.json',
      'context/measurements.json',
      'context/metrics.json',
    ]);
    assert.match(
      request.projectFiles['AGENTS.md']!,
      /reflective GEPA mutation/,
    );
    const candidates = output.candidates as JsonObject[];
    const best = candidates.find(
      (candidate) => candidate.ref === output.bestCandidateRef,
    );
    const tree = object(
      await run.manager.artifacts.readJson(string(best!.artifactRef)),
    );
    const files = decodeTree(tree);
    assert.equal(files['a.md'], 'A1');
    assert.equal(files['b.md'], 'B0');
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.strategy, 'mutation');
    assert.equal(rounds[0]!.status, 'admitted');
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('checkpoint resume in a fresh Manager preserves task sampling, budgets and module rotation without repeating external calls', async () => {
  const scores = (value: number): Record<string, number> =>
    Object.fromEntries(
      ['f1', 'f2', 'f3', 's1', 's2', 's3'].map((task) => [task, value]),
    );
  const options = {
    seed: 11,
    maxRounds: 2,
    maxRollouts: 40,
    feedbackTasks: ['f1', 'f2', 'f3'],
    selectionTasks: ['s1', 's2', 's3'],
    scoreTable: {
      'A0|B0': { scores: scores(0.1) },
      'A1|B0': { scores: scores(0.5) },
      'A1|B1': { scores: scores(0.9) },
    },
    proposals: { a: 'A1', b: 'B1' },
  };
  const complete = await runGepa(options);
  let resumed: Awaited<ReturnType<typeof runGepa>> | undefined;
  try {
    resumed = await runGepa({
      ...options,
      resumeAfterEvaluation: 2,
      restartOnResume: true,
    });
    assert.equal(resumed.interrupted?.status, 'cancelled');
    assert.deepEqual(resumed.output, complete.output);
    assert.deepEqual(resumed.evaluationCalls, complete.evaluationCalls);
    assert.deepEqual(
      resumed.agentCalls.map((call) => call.moduleId),
      ['a', 'b'],
    );
    assert.equal(resumed.evaluationCalls.length, 7);
    assert.equal(resumed.agentCalls.length, complete.agentCalls.length);
    assert.equal(resumed.output.rolloutsUsed, 14);
    assert.equal(resumed.output.completedRounds, 2);
    assert.deepEqual(
      (await resumed.manager.get('gepa-runtime')).usage,
      (await complete.manager.get('gepa-runtime')).usage,
    );
  } finally {
    await complete.manager.dispose();
    await rm(complete.root, { recursive: true, force: true });
    if (resumed) {
      await resumed.manager.dispose();
      await rm(resumed.root, { recursive: true, force: true });
    }
  }
});

test('crossover eligibility retains a non-instance-winning parent and admission compares both sources', async () => {
  // Base wins both selection instances and dominates the first mutation so the
  // second mutation deterministically starts from base. The two mutations are
  // therefore sibling branches with complementary module changes.
  const run = await runGepa({
    seed: 3,
    maxRounds: 4,
    maxRollouts: 40,
    feedbackTasks: ['feedback-a', 'feedback-b'],
    selectionTasks: ['selection-a', 'selection-b'],
    scoreTable: {
      'A0|B0': {
        scores: {
          'feedback-a': 0.2,
          'feedback-b': 0.2,
          'selection-a': 1,
          'selection-b': 0.6,
        },
      },
      'A1|B0': {
        scores: {
          'feedback-a': 0.9,
          'feedback-b': 0.9,
          'selection-a': 0.9,
          'selection-b': 0.7,
        },
      },
      'A0|B1': {
        scores: {
          'feedback-a': 0.85,
          'feedback-b': 0.85,
          'selection-a': 0.7,
          'selection-b': 0.9,
        },
      },
      'A1|B1': {
        scores: {
          'feedback-a': 1,
          'feedback-b': 1,
          'selection-a': 0.95,
          'selection-b': 0.95,
        },
      },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const output = run.output;
    const rounds = output.rounds as JsonObject[];
    assert.ok(rounds.length <= 4);
    assert.equal(output.completedRounds, rounds.length);
    // The third strategy is crossover and must compare the merged candidate
    // with both source siblings, never with the common construction ancestor.
    const crossover = rounds.find((round) => round.strategy === 'crossover');
    assert.ok(crossover, 'expected an admitted crossover round');
    assert.equal(crossover.status, 'admitted');
    assert.equal((crossover.parentRefs as string[]).length, 2);
    assert.equal(crossover.parentMean, undefined);
    assert.equal(crossover.leftMean !== undefined, true);
    assert.equal(crossover.rightMean !== undefined, true);
    assert.equal(crossover.proposalMean, 1);
    assert.equal(output.completedRounds, 4);
    assert.equal(rounds[3]!.strategy, 'mutation');
    assert.deepEqual(rounds[3]!.moduleIds, ['a']);
    assert.equal(run.agentCalls.length, 3);
    assert.deepEqual(
      run.agentCalls.map((call) => call.moduleId),
      ['a', 'b', 'a'],
    );
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('small rollout allowances truncate before evaluation and never exceed the boundary', async () => {
  const run = await runGepa({
    seed: 2,
    maxRounds: 3,
    maxRollouts: 1,
    feedbackTasks: ['task-a', 'task-b'],
    selectionTasks: ['task-a', 'task-b'],
    scoreTable: {
      'A0|B0': {
        scores: { 'task-a': 1, 'task-b': 1 },
      },
      'A1|B0': { scores: { 'task-a': 1, 'task-b': 1 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = run.output;
    assert.equal(output.rolloutsUsed, 1);
    assert.equal(output.completedRounds, 0);
    assert.equal(run.evaluationCalls.length, 1);
    assert.equal(run.evaluationCalls[0]!.taskIds.length, 1);
    assert.equal((output.selectionTaskIds as string[]).length, 1);
    assert.equal(run.agentCalls.length, 0);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('unavailable and failed evaluations stay unknown instead of becoming zero', async () => {
  const unavailable = await runGepa({
    seed: 5,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': null } },
      'A1|B0': { scores: { 'task-a': 0.9 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = unavailable.output;
    assert.equal(output.bestAggregateScore, null);
    assert.equal(output.bestCandidateRef, null);
    assert.equal(output.completedRounds, 0);
    assert.equal(unavailable.agentCalls.length, 0);
  } finally {
    await unavailable.manager.dispose();
    await rm(unavailable.root, { recursive: true, force: true });
  }

  const failed = await runGepa({
    seed: 5,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['feedback-a'],
    selectionTasks: ['selection-a'],
    scoreTable: {
      'A0|B0': {
        scores: { 'feedback-a': 0.8, 'selection-a': 0.8 },
        statuses: { 'feedback-a': 'failed' },
      },
      'A1|B0': {
        scores: { 'feedback-a': 0.9, 'selection-a': 0.9 },
      },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = failed.output;
    assert.equal(output.completedRounds, 0);
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.status, 'evaluation-failed');
    assert.match(String(rounds[0]!.reason), /unavailable/);
    assert.equal(output.bestAggregateScore, 0.8);
    assert.notEqual(output.bestCandidateRef, null);
  } finally {
    await failed.manager.dispose();
    await rm(failed.root, { recursive: true, force: true });
  }
});

test('a no-change proposal is recorded without counting a completed round', async () => {
  const run = await runGepa({
    seed: 8,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0.7 } },
    },
    proposals: { a: 'A0' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 0);
    assert.equal((output.rounds as JsonObject[]).length, 1);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.evaluationCalls.length, 2);
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.status, 'no-change');
    assert.equal(output.bestAggregateScore, 0.7);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('three logical reflection attempts are executed and counted separately', async () => {
  const run = await runGepa({
    seed: 3,
    maxRounds: 3,
    maxRollouts: 40,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 1 } },
      'A1|B0': { scores: { 'task-a': 0.2 } },
      'A2|B0': { scores: { 'task-a': 0.3 } },
      'A0|B1': { scores: { 'task-a': 0.4 } },
    },
    proposals: { a: 'A2', b: 'B1' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 3);
    assert.equal(run.agentCalls.length, 3);
    assert.deepEqual(
      run.agentCalls.map((call) => call.moduleId),
      ['a', 'b', 'a'],
    );
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds.length, 3);
    assert.ok(rounds.every((round) => round.status === 'rejected'));
    // Initial selection + parent/proposal for each of the three logical rounds.
    assert.equal(output.rolloutsUsed, 7);
    assert.equal(run.evaluationCalls.length, 7);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

for (const mergedScore of [0.4, 0.875, 0.9]) {
  test(`a final-round crossover with score ${mergedScore} compares against the better parent and stops`, async () => {
    const run = await runGepa({
      seed: 3,
      maxRounds: 3,
      maxRollouts: 40,
      feedbackTasks: ['feedback-a', 'feedback-b'],
      selectionTasks: ['selection-a', 'selection-b'],
      scoreTable: {
        'A0|B0': {
          scores: {
            'feedback-a': 0.2,
            'feedback-b': 0.2,
            'selection-a': 1,
            'selection-b': 0.6,
          },
        },
        'A1|B0': {
          scores: {
            'feedback-a': 0.9,
            'feedback-b': 0.9,
            'selection-a': 0.9,
            'selection-b': 0.7,
          },
        },
        'A0|B1': {
          scores: {
            'feedback-a': 0.85,
            'feedback-b': 0.85,
            'selection-a': 0.7,
            'selection-b': 0.9,
          },
        },
        'A1|B1': {
          scores: {
            'feedback-a': mergedScore,
            'feedback-b': mergedScore,
            'selection-a': 0.95,
            'selection-b': 0.95,
          },
        },
      },
      proposals: { a: 'A1', b: 'B1' },
    });
    try {
      const output = run.output;
      const rounds = output.rounds as JsonObject[];
      assert.equal(output.completedRounds, 3);
      assert.equal(rounds.length, 3);
      assert.equal(rounds[2]!.strategy, 'crossover');
      assert.equal(
        rounds[2]!.status,
        mergedScore === 0.9 ? 'admitted' : 'rejected',
      );
      if (mergedScore === 0.9) {
        assert.equal(output.bestAggregateScore, 0.95);
        assert.equal((output.candidates as JsonObject[]).length, 4);
      } else {
        assert.match(String(rounds[2]!.reason), /both genetic source parents/);
        assert.equal((output.candidates as JsonObject[]).length, 3);
      }
      assert.equal(run.agentCalls.length, 2);
      assert.equal(output.rolloutsUsed, mergedScore === 0.9 ? 22 : 20);
    } finally {
      await run.manager.dispose();
      await rm(run.root, { recursive: true, force: true });
    }
  });
}

test('a measured zero is retained as a valid best aggregate', async () => {
  const run = await runGepa({
    seed: 1,
    maxRounds: 0,
    maxRollouts: 4,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0 } },
    },
    proposals: {},
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 0);
    assert.equal(output.rolloutsUsed, 1);
    assert.equal(output.bestAggregateScore, 0);
    assert.notEqual(output.bestCandidateRef, null);
    assert.equal(run.evaluationCalls.length, 1);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('eight controlled evidence reads plus a final response fit the reflective session', async () => {
  const run = await runGepa({
    seed: 6,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0.2 } },
      'A1|B0': { scores: { 'task-a': 0.9 } },
    },
    proposals: { a: 'A1' },
    reads: 8,
    modelCallBudget: 12,
  });
  try {
    assert.equal(run.output.completedRounds, 1);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.agentCalls[0]!.modelCalls, 9);
    assert.equal(
      object((await run.manager.get('gepa-runtime')).usage).modelCalls,
      9,
    );
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('Proposer receives the existing training summary while Runtime retains full executions', async () => {
  const run = await runGepa({
    seed: 6,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': {
        scores: { 'task-a': 0.2 },
        marker: 'baseline-output',
        trajectoryPadding: 600,
      },
      'A1|B0': { scores: { 'task-a': 0.9 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    assert.equal(run.output.completedRounds, 1);
    const request = run.agentCalls[0]!;
    const summary = JSON.stringify(request.evidence);
    assert.match(summary, /"value":0.2/);
    assert.match(summary, /feedback for task-a/);
    assert.equal(request.evidence.truncated, true);
    assert.equal(request.metadata.executionEvidence, undefined);
    assert.deepEqual(Object.keys(request.candidateFiles).sort(), [
      'a.md',
      'b.md',
    ]);
    const measurements = await run.manager.facts.list('measurements');
    const baseline = measurements.find(
      (measurement) =>
        measurement.candidateRef === run.output.baselineCandidateRef,
    )!;
    const catalog = object(
      await run.manager.artifacts.readJson(string(baseline.evidenceIndexRef)),
    );
    const entry = object((catalog.entries as JsonObject[])[0]);
    const trace = decodeTree(
      object(await run.manager.artifacts.readJson(string(entry.artifactRef))),
    )['trajectory.jsonl']!;
    assert.ok(Buffer.byteLength(trace) > 60000);
    assert.match(trace, /TASK_INPUT_MARKER task-a/);
    assert.match(trace, /AGENT_OUTPUT_MARKER baseline-output/);
    assert.match(trace, /LATE_EXECUTION_MARKER task-a/);
    assert.equal(request.candidateFiles['a.md'], 'A0');
    assert.equal(request.candidateFiles['b.md'], 'B0');
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

for (const [name, edit, reason] of [
  [
    'another module',
    { op: 'replace', path: 'b.md', content: 'B1' },
    /not authorized/,
  ],
  ['deleted module', { op: 'delete', path: 'a.md' }, /not authorized/],
  [
    'empty module',
    { op: 'replace', path: 'a.md', content: '' },
    /content size/,
  ],
] as const) {
  test(`the shared Proposer rejects ${name} before candidate evaluation`, async () => {
    await expectRunFailure(
      {
        seed: 6,
        maxRounds: 1,
        maxRollouts: 20,
        feedbackTasks: ['task-a'],
        selectionTasks: ['task-a'],
        scoreTable: { 'A0|B0': { scores: { 'task-a': 0.2 } } },
        proposals: {},
        agentOutput: { edits: [edit], reason: 'Attempt a forbidden edit' },
      },
      reason,
    );
  });
}

test('empty edits from the shared Proposer retain the parent without evaluation', async () => {
  const run = await runGepa({
    seed: 6,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: { 'A0|B0': { scores: { 'task-a': 0.2 } } },
    proposals: { a: null },
  });
  try {
    const round = (run.output.rounds as JsonObject[])[0]!;
    assert.equal(round.status, 'no-change');
    assert.equal(run.output.completedRounds, 0);
    assert.equal(run.evaluationCalls.length, 2);
    assert.equal((run.output.candidates as JsonObject[]).length, 1);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('a failed Policy evaluator call stops before invoking the Proposer', async () => {
  await expectRunFailure(
    {
      seed: 6,
      maxRounds: 1,
      maxRollouts: 20,
      feedbackTasks: ['feedback'],
      selectionTasks: ['selection'],
      scoreTable: {
        'A0|B0': {
          scores: { selection: 0.2 },
          byTaskSet: {
            feedback: { scores: {}, error: 'controlled evaluator failure' },
          },
        },
      },
      proposals: { a: 'A1' },
    },
    /controlled evaluator failure/,
    2,
    0,
  );
});

test('mutation treats module path metacharacters literally and rejects an expanded sibling', async () => {
  const path = 'a!{b,c}[x].md';
  const sibling = 'a!b[x].md';
  for (const editSibling of [false, true]) {
    const options: Parameters<typeof runGepa>[0] = {
      seed: 6,
      maxRounds: 1,
      maxRollouts: 20,
      feedbackTasks: ['task-a'],
      selectionTasks: ['task-a'],
      modules: [{ id: 'a', path }],
      baselineFiles: { [path]: 'A0', [sibling]: 'B0' },
      scoreTable: {
        'A0|B0': { scores: { 'task-a': 0.2 } },
        'A1|B0': { scores: { 'task-a': 0.9 } },
      },
      proposals: { a: 'A1' },
      ...(editSibling
        ? {
            agentOutput: {
              edits: [{ op: 'replace', path: sibling, content: 'B1' }],
              reason: 'Try a sibling',
            },
          }
        : {}),
    };
    if (editSibling) {
      await expectRunFailure(options, /not authorized/);
      continue;
    }
    const run = await runGepa(options);
    try {
      const round = (run.output.rounds as JsonObject[])[0]!;
      assert.equal(round.status, 'admitted');
      assert.equal(run.evaluationCalls.length, 4);
      assert.equal(run.evaluationCalls[2]!.files[path], 'A1');
      assert.equal(run.evaluationCalls[2]!.files[sibling], 'B0');
    } finally {
      await run.manager.dispose();
      await rm(run.root, { recursive: true, force: true });
    }
  }
});

const constraintCases: {
  label: string;
  editConstraints: JsonObject;
  agentCalls: number;
  reason: RegExp;
}[] = [
  {
    label: 'original allowed paths',
    editConstraints: { allowedPaths: ['b.md'] },
    agentCalls: 0,
    reason: /outside editConstraints.allowedPaths/,
  },
  {
    label: 'zero changed files',
    editConstraints: { maxChangedFiles: 0 },
    agentCalls: 1,
    reason: /maxChangedFiles/,
  },
];
for (const entry of constraintCases) {
  test(`GEPA module narrowing preserves ${entry.label}`, async () => {
    await expectRunFailure(
      {
        seed: 6,
        maxRounds: 1,
        maxRollouts: 20,
        feedbackTasks: ['task-a'],
        selectionTasks: ['task-a'],
        scoreTable: { 'A0|B0': { scores: { 'task-a': 0.2 } } },
        proposals: { a: 'A1' },
        editConstraints: entry.editConstraints,
      },
      entry.reason,
      entry.agentCalls === 0 ? 1 : 2,
      entry.agentCalls,
    );
  });
}

test('malformed reflective outputs fail before committing or evaluating a proposal', async () => {
  const malformedOutputs: JsonObject[] = [
    {
      edits: [{ op: 'replace', path: 'a.md', content: 42 }],
      reason: 'Invalid replacement type',
    },
    { edits: [{ op: 'replace', path: 'a.md', content: 'A1' }] },
  ];
  for (const agentOutput of malformedOutputs) {
    await expectRunFailure(
      {
        seed: 6,
        maxRounds: 1,
        maxRollouts: 20,
        feedbackTasks: ['task-a'],
        selectionTasks: ['task-a'],
        scoreTable: {
          'A0|B0': { scores: { 'task-a': 0.2 } },
          'A1|B0': { scores: { 'task-a': 0.9 } },
        },
        proposals: {},
        agentOutput,
      },
      /Agent edit output/,
    );
  }
});
