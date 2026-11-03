import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateLabel,
  scoreLabel,
  exactScoreLabel,
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
test('score labels retain zero and do not round small nonzero values to zero', () => {
  assert.equal(scoreLabel(0), '0');
  assert.equal(scoreLabel(0.33335), '0.33335');
  assert.equal(scoreLabel(1e-12), '1.000e-12');
  assert.equal(scoreLabel(-0.25), '-0.25');
});

test('selected score precision is exact while rounded chart labels are explicit', () => {
  assert.equal(exactScoreLabel(2 / 3), '0.6666666666666666');
  assert.equal(exactScoreLabel(0), '0');
  assert.equal(exactScoreLabel(1e-12), '0.000000000001');
  assert.equal(scoreLabel(2 / 3), '≈0.6666667');
});
