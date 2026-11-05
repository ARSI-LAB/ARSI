import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateLabel,
  scoreLabel,
} from '../../web/features/experiments/record-identifiers.js';
test('candidate labels derive from immutable IDs, including human-readable mock IDs', () => {
  assert.equal(
    candidateLabel('mock-web-showcase-20261031-candidate-07'),
    'C-07',
  );
  assert.equal(
    candidateLabel('candidate-527c66e1b17596c643e4ab1ad9c2bece'),
    'C-527c66…bece',
  );
  assert.notEqual(
    candidateLabel('candidate-527c66e1b17596c643e4ab1ad9c2bece'),
    candidateLabel('candidate-527c66e1b17596c643e4ab1ad9c2becf'),
  );
});
test('score labels round small values without scientific notation', () => {
  assert.equal(scoreLabel(0), '0');
  assert.equal(scoreLabel(0.33335), '0.33');
  assert.equal(scoreLabel(1e-12), '0');
  assert.equal(scoreLabel(-0.25), '-0.25');
  assert.equal(scoreLabel(0.005), '0.01');
  assert.equal(scoreLabel(-0.0049), '0');
  assert.doesNotMatch(scoreLabel(1e21), /e[+-]?\d/i);
});

test('all score displays use two decimals without floating-point noise', () => {
  assert.equal(scoreLabel(2 / 3), '0.67');
  assert.equal(scoreLabel(0.9141400000000001), '0.91');
  assert.equal(scoreLabel(-0), '0');
  assert.equal(scoreLabel(42), '42');
  assert.equal(scoreLabel(-1e-12), '0');
});
