import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Rng,
  ancestry,
  bestCandidate,
  candidateAggregate,
  dominates,
  findMerge,
  mergePrompts,
  paretoChoice,
  selectCandidate,
  type CandidateRecord,
} from '../../src/plugins/search-prompt-evolution/engine.js';

function candidate(
  ref: string,
  scores: Record<string, number | null>,
  parents: string[] = [],
  ancestors: string[] = [],
): CandidateRecord {
  return {
    ref,
    artifactRef: `artifact-${ref}`,
    applicationParentRef: parents[0] ?? null,
    parents,
    ancestors,
    origin:
      parents.length > 1 ? 'crossover' : parents.length ? 'mutation' : 'base',
    createdRound: parents.length ? 1 : 0,
    scores,
    aggregate: null,
    aggregateComplete: false,
    moduleIds: ['a', 'b'],
  };
}

const modules = [
  { id: 'a', path: 'a.md' },
  { id: 'b', path: 'b.md' },
];

test('GEPA keeps a measured zero distinct from unavailable scores', () => {
  const zero = candidateAggregate({ scores: { first: 0, second: 0 } }, [
    'first',
    'second',
  ]);
  assert.equal(zero.aggregate, 0);
  assert.equal(zero.complete, true);
  const unavailable = candidateAggregate(
    { scores: { first: 0, second: null } },
    ['first', 'second'],
  );
  assert.equal(unavailable.aggregate, 0);
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.observed, 1);
});

test('mutation sampling compares complete finite selection vectors', () => {
  const tasks = ['first', 'second'];
  const complete = candidate('complete', { first: 0.5, second: 0.5 });
  const incomplete = candidate('incomplete', { first: 1, second: null });
  const missing = candidate('missing', { first: 1 });
  const nonFinite = candidate('non-finite', { first: 1, second: Infinity });
  const invalid = [incomplete, missing, nonFinite];
  for (const entry of invalid) {
    assert.equal(dominates(entry, complete, tasks), false);
    assert.equal(dominates(complete, entry, tasks), false);
  }
  assert.equal(dominates(complete, complete, tasks), false);
  assert.equal(
    dominates(
      candidate('better', { first: 0.5, second: 0.6 }),
      complete,
      tasks,
    ),
    true,
  );
  const choice = paretoChoice([...invalid, complete], tasks);
  assert.deepEqual(
    choice.candidates.map((entry) => entry.ref),
    ['complete'],
  );
  assert.equal(choice.weights.get('complete'), 2);
  for (let seed = 0; seed < 10; seed++)
    assert.equal(
      selectCandidate([...invalid, complete], tasks, new Rng(seed))?.ref,
      'complete',
    );
  assert.equal(selectCandidate(invalid, tasks, new Rng(1)), null);
});

test('duplicate candidate references do not increase sampling frequency', () => {
  const tasks = ['first', 'second', 'third'];
  const left = candidate('left', { first: 1, second: 1, third: 0 });
  const right = candidate('right', { first: 0, second: 0, third: 1 });
  const unique = [left, right];
  const duplicated = [left, right, left];
  const choice = paretoChoice(duplicated, tasks);
  assert.deepEqual(
    choice.candidates.map((entry) => entry.ref),
    ['left', 'right'],
  );
  assert.deepEqual(Object.fromEntries(choice.weights), { left: 2, right: 1 });
  for (let seed = 0; seed < 20; seed++)
    assert.equal(
      selectCandidate(duplicated, tasks, new Rng(seed))?.ref,
      selectCandidate(unique, tasks, new Rng(seed))?.ref,
    );
});

test('Pareto sampling prunes tied leaders without losing instance coverage', () => {
  const tasks = ['first', 'second'];
  const older = candidate('older', { first: 1, second: 1 });
  const newer = candidate('newer', { first: 1, second: 1 });
  const choice = paretoChoice([older, newer], tasks);
  assert.deepEqual(
    choice.candidates.map((entry) => entry.ref),
    ['newer'],
  );
  assert.deepEqual(Object.fromEntries(choice.weights), { newer: 2 });
  for (let seed = 0; seed < 10; seed++)
    assert.equal(
      selectCandidate([older, newer], tasks, new Rng(seed))?.ref,
      'newer',
    );
});

test('Pareto sampling removes leaders covered collectively by stronger specialists', () => {
  const tasks = ['first', 'second', 'third', 'fourth'];
  const left = candidate('left', { first: 1, second: 0, third: 1, fourth: 1 });
  const right = candidate('right', {
    first: 0,
    second: 1,
    third: 1,
    fourth: 1,
  });
  const redundant = candidate('redundant', {
    first: 1,
    second: 1,
    third: 0,
    fourth: 0,
  });
  assert.equal(dominates(left, redundant, tasks), false);
  assert.equal(dominates(right, redundant, tasks), false);
  const choice = paretoChoice([left, right, redundant], tasks);
  assert.deepEqual(
    choice.candidates.map((entry) => entry.ref),
    ['left', 'right'],
  );
  assert.deepEqual(Object.fromEntries(choice.weights), { left: 3, right: 3 });
});

test('equal aggregate pruning follows the first winning task order', () => {
  const tasks = ['first', 'second', 'third'];
  const older = candidate('older', { first: 0, second: 1, third: 1 });
  const firstLeader = candidate('first-leader', {
    first: 1,
    second: 0,
    third: 1,
  });
  const other = candidate('other', { first: 1, second: 1, third: 0 });
  const choice = paretoChoice([older, firstLeader, other], tasks);
  assert.deepEqual(
    choice.candidates.map((entry) => entry.ref),
    ['older', 'other'],
  );
  assert.deepEqual(Object.fromEntries(choice.weights), { older: 2, other: 2 });
});

test('Pareto sampling removes dominated candidates but not crossover eligibility', () => {
  const base = candidate('base', { first: 0.1, second: 0.1 });
  const left = candidate('left', { first: 1, second: 0 }, ['base'], ['base']);
  const balanced = candidate(
    'balanced',
    { first: 0.8, second: 0.8 },
    ['base'],
    ['base'],
  );
  const specialist = candidate(
    'specialist',
    { first: 0, second: 1 },
    ['base'],
    ['base'],
  );
  const choice = paretoChoice(
    [base, left, balanced, specialist],
    ['first', 'second'],
  );
  // The balanced source wins no individual instance, so it is not in the
  // mutation sampling pool and may be dominated there. Crossover still sees it.
  assert.equal(choice.weights.get('balanced'), undefined);
  assert.ok(choice.weights.get('left'));
  assert.ok(choice.weights.get('specialist'));

  const prompts = {
    base: { a: 'A0', b: 'B0' },
    left: { a: 'A1', b: 'B0' },
    balanced: { a: 'A0', b: 'B1' },
    specialist: { a: 'A2', b: 'B0' },
  };
  const selected = new Set<string>();
  for (let seed = 0; seed < 40; seed++) {
    const merge = findMerge(
      [base, left, balanced, specialist],
      ['first', 'second'],
      modules,
      [],
      prompts,
      new Rng(seed),
      128,
    );
    assert.ok(merge, `seed ${seed} should find the complementary merge`);
    selected.add(merge.left.ref);
    selected.add(merge.right.ref);
    assert.ok(
      merge.left.ref === 'balanced' || merge.right.ref === 'balanced',
      `seed ${seed} lost the non-instance-winning source`,
    );
  }
  assert.ok(selected.has('balanced'));
});

test('crossover copies complementary modules, preserves others and resolves ties deterministically', () => {
  const base = candidate('base', { first: 0.1 });
  const left = candidate('left', { first: 0.9 }, ['base'], ['base']);
  const right = candidate('right', { first: 0.9 }, ['base'], ['base']);
  const prompts = {
    base: { a: 'A0', b: 'B0' },
    left: { a: 'A1', b: 'B0' },
    right: { a: 'A0', b: 'B1' },
  };
  const merged = mergePrompts(
    modules,
    base,
    left,
    right,
    prompts,
    0.9,
    0.9,
    new Rng(7),
  );
  assert.deepEqual(merged, { a: 'A1', b: 'B1' });
  assert.deepEqual(
    mergePrompts(modules, base, left, right, prompts, 0.9, 0.9, new Rng(7)),
    merged,
  );
});

test('ancestry excludes descendants directly and transitively', () => {
  const base = candidate('base', { task: 1 });
  const child = candidate('child', { task: 0.5 }, ['base'], ['base']);
  const merged = candidate(
    'merged',
    { task: 0.75 },
    ['child', 'other'],
    ['base', 'child', 'other'],
  );
  const candidates = [base, child, merged];
  const byRef = new Map(candidates.map((entry) => [entry.ref, entry]));
  assert.deepEqual([...ancestry(child, byRef)].sort(), ['base']);
  assert.deepEqual([...ancestry(merged, byRef)].sort(), [
    'base',
    'child',
    'other',
  ]);
  const prompts = {
    base: { a: 'A0', b: 'B0' },
    child: { a: 'A1', b: 'B0' },
    other: { a: 'A0', b: 'B1' },
    merged: { a: 'A1', b: 'B1' },
  };
  const direct = findMerge(
    [base, child],
    ['task'],
    modules,
    [],
    prompts,
    new Rng(3),
  );
  assert.equal(direct, null);
  const descendant = findMerge(
    [child, merged],
    ['task'],
    modules,
    [],
    prompts,
    new Rng(3),
  );
  assert.equal(descendant, null);
});

test('best aggregate uses only complete, observed selection scores', () => {
  const incomplete = candidate('incomplete', { first: 1, second: null });
  const lower = candidate('lower', { first: 0.5, second: 0.5 });
  const zero = candidate('zero', { first: 0, second: 0 });
  assert.equal(
    bestCandidate([incomplete, lower], ['first', 'second']).candidate?.ref,
    'lower',
  );
  assert.equal(
    bestCandidate([incomplete, lower, zero], ['first', 'second']).candidate
      ?.ref,
    'lower',
  );
  assert.deepEqual(bestCandidate([incomplete], ['first', 'second']), {
    candidate: null,
    score: null,
  });
  assert.equal(
    selectCandidate([incomplete, lower], ['first', 'second'], new Rng(1))?.ref,
    'lower',
  );
});
