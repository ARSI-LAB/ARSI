import test from 'node:test';
import assert from 'node:assert/strict';
import { gepaPlanSchema } from '../../src/contracts/plugin-types/gepa.js';
import { validate } from '../../src/shared/schema.js';

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
