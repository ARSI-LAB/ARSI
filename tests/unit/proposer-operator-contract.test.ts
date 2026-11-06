import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../../src/contracts/plugin-types/index.js';
import { defineContract } from '../../src/contracts/contract.js';
import { validate } from '../../src/shared/schema.js';

function contract() {
  const value: unknown = Reflect.get(contracts, 'operatorProposerContract');
  assert.notEqual(
    value,
    undefined,
    'The operator Proposer contract must be exported',
  );
  return defineContract(value);
}

const propose = {
  action: 'propose',
  phase: 'static',
  entryCandidateRef: 'candidate:baseline',
  baselineMeasurementRef: 'measurement:baseline',
  attempt: 1,
  goal: 'Improve measured latency',
  analysisRef: null,
  historyRef: null,
};
const repair = {
  action: 'repair',
  phase: 'static',
  failedCandidateRef: 'candidate:failed',
  measurementRef: 'measurement:failed',
  analysisRef: 'artifact:analysis',
  historyRef: null,
  attempt: 1,
  repairIndex: 1,
  goal: 'Repair the recorded compile failure',
};
const summarize = {
  action: 'summarize',
  phase: 'static',
  entryCandidateRef: 'candidate:baseline',
  analysisRef: 'artifact:analysis',
  historyRef: null,
  attempt: 1,
  candidateRefs: ['candidate:attempt'],
  measurementRefs: [],
  decisionRef: null,
  outcome: 'no-change',
};

test('operator Proposer accepts all three actions with explicit nullable references', () => {
  const schema = contract().input_schema;
  for (const input of [propose, repair, summarize]) validate(schema, input);
  validate(schema, {
    ...propose,
    attempt: 3,
    analysisRef: 'a',
    historyRef: 'h',
  });
  validate(schema, { ...repair, attempt: 3, repairIndex: 3 });
  validate(schema, {
    ...summarize,
    candidateRefs: ['c1', 'c2', 'c3', 'c4'],
    measurementRefs: ['m1', 'm2', 'm3', 'm4'],
    outcome: 'verification-failed',
  });
});

test('operator Proposer rejects unknown actions, extra fields and missing action-specific evidence', () => {
  const schema = contract().input_schema;
  const { baselineMeasurementRef: _baseline, ...missingBaseline } = propose;
  const { historyRef: _history, ...missingHistory } = propose;
  const { decisionRef: _decision, ...missingDecision } = summarize;
  for (const input of [
    { ...propose, action: 'diagnose' },
    { ...propose, debug: true },
    { ...repair, entryCandidateRef: 'c' },
    missingBaseline,
    missingHistory,
    missingDecision,
    { ...propose, baselineMeasurementRef: '' },
    { ...repair, analysisRef: null },
    { ...summarize, outcome: 'model-claims-success' },
  ])
    assert.throws(() => validate(schema, input));
});

test('operator Proposer accepts configured search counts beyond former ceilings', () => {
  const schema = contract().input_schema;
  validate(schema, { ...propose, attempt: 4 });
  validate(schema, { ...repair, attempt: 4, repairIndex: 4 });
  validate(schema, {
    ...summarize,
    attempt: 4,
    candidateRefs: ['c1', 'c2', 'c3', 'c4', 'c5'],
    measurementRefs: ['m1', 'm2', 'm3', 'm4', 'm5'],
  });
  validate(schema, {
    action: 'propose',
    phase: 'metrics',
    parentCandidateRef: 'candidate:parent',
    incumbentMeasurementRef: 'measurement:incumbent',
    diagnosticMeasurementRef: 'measurement:diagnostic',
    round: 11,
    historyRef: null,
    staticHistoryRef: null,
    goal: 'Continue the configured search',
  });
});

test('operator Proposer requires positive integer counts and unique candidate chains', () => {
  const schema = contract().input_schema;
  for (const attempt of [0, 1.5])
    assert.throws(() => validate(schema, { ...propose, attempt }));
  for (const repairIndex of [0, 1.5])
    assert.throws(() => validate(schema, { ...repair, repairIndex }));
  for (const candidateRefs of [[], ['c', 'c']])
    assert.throws(() => validate(schema, { ...summarize, candidateRefs }));
  for (const measurementRefs of [['m', 'm']])
    assert.throws(() => validate(schema, { ...summarize, measurementRefs }));
});

test('operator Proposer output distinguishes committed candidates from valid no-change outcomes', () => {
  const schema = contract().output_schema;
  const created = {
    action: 'propose',
    status: 'created',
    candidateRef: 'candidate:new',
    diffRef: 'artifact:diff',
    rationale: 'One tiling change',
    analysisRef: 'artifact:analysis',
    reasonCode: 'created',
  };
  const unchanged = {
    ...created,
    status: 'no-change',
    diffRef: null,
    reasonCode: 'no-static-issues',
  };
  for (const output of [
    created,
    { ...created, action: 'repair' },
    unchanged,
    { ...unchanged, reasonCode: 'no-supported-change' },
    { ...unchanged, action: 'repair', reasonCode: 'no-supported-change' },
    {
      action: 'summarize',
      historyRef: 'artifact:history',
      summaryRef: 'artifact:summary',
    },
  ])
    validate(schema, output);
  for (const output of [
    { ...created, diffRef: null },
    { ...created, reasonCode: 'no-static-issues' },
    { ...unchanged, diffRef: 'artifact:diff' },
    { ...unchanged, reasonCode: 'created' },
    { ...unchanged, action: 'repair' },
    { ...created, analysisRef: null },
    { ...created, unsupported: true },
    { action: 'summarize', historyRef: null, summaryRef: 's' },
  ])
    assert.throws(() => validate(schema, output));
});
