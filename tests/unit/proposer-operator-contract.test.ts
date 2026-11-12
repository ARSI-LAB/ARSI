import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operatorProposerContract,
  operatorSummarizerContract,
} from '../../src/contracts/plugin-types/index.js';
import { validate } from '../../src/shared/schema.js';

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
const actions = [
  {
    action: 'propose',
    status: 'no-change',
    candidateRef: 'candidate:baseline',
    diffRef: null,
    rationale: 'No supported change',
    analysisRef: 'artifact:analysis',
    reasonCode: 'no-supported-change',
  },
];
const summarize = {
  actions,
  action: 'summarize',
  phase: 'static',
  entryCandidateRef: 'candidate:baseline',
  analysisRef: 'artifact:analysis',
  historyRef: null,
  attempt: 1,
  candidateRefs: ['candidate:baseline'],
  measurementRefs: [],
  decisionRef: null,
  outcome: 'no-change',
};

test('operator Proposer accepts proposals and repairs with explicit nullable references', () => {
  const schema = operatorProposerContract.input_schema;
  for (const input of [propose, repair]) validate(schema, input);
  validate(schema, {
    ...propose,
    attempt: 3,
    analysisRef: 'a',
    historyRef: 'h',
  });
  validate(schema, { ...repair, attempt: 3, repairIndex: 3 });
  validate(operatorSummarizerContract.input_schema, {
    ...summarize,
    candidateRefs: ['c1', 'c2', 'c3', 'c4'],
    measurementRefs: ['m1', 'm2', 'm3', 'm4'],
    outcome: 'verification-failed',
  });
});

test('operator Proposer rejects unknown actions, extra fields and missing action-specific evidence', () => {
  const schema = operatorProposerContract.input_schema;
  const { baselineMeasurementRef: _baseline, ...missingBaseline } = propose;
  const { historyRef: _history, ...missingHistory } = propose;
  const { decisionRef: _decision, ...missingDecision } = summarize;
  for (const input of [
    { ...propose, action: 'diagnose' },
    { ...propose, debug: true },
    { ...repair, entryCandidateRef: 'c' },
    missingBaseline,
    missingHistory,
    { ...propose, baselineMeasurementRef: '' },
    { ...repair, analysisRef: null },
  ])
    assert.throws(() => validate(schema, input));
  for (const input of [
    missingDecision,
    { ...summarize, outcome: 'model-claims-success' },
  ])
    assert.throws(() =>
      validate(operatorSummarizerContract.input_schema, input),
    );
});

test('operator Proposer accepts configured search counts beyond former ceilings', () => {
  const schema = operatorProposerContract.input_schema;
  validate(schema, { ...propose, attempt: 4 });
  validate(schema, { ...repair, attempt: 4, repairIndex: 4 });
  validate(operatorSummarizerContract.input_schema, {
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
  const schema = operatorProposerContract.input_schema;
  for (const attempt of [0, 1.5])
    assert.throws(() => validate(schema, { ...propose, attempt }));
  for (const repairIndex of [0, 1.5])
    assert.throws(() => validate(schema, { ...repair, repairIndex }));
  for (const candidateRefs of [[], ['c', 'c']])
    assert.throws(() =>
      validate(operatorSummarizerContract.input_schema, {
        ...summarize,
        candidateRefs,
      }),
    );
  for (const measurementRefs of [['m', 'm']])
    assert.throws(() =>
      validate(operatorSummarizerContract.input_schema, {
        ...summarize,
        measurementRefs,
      }),
    );
});

test('operator Proposer output distinguishes committed candidates from valid no-change outcomes', () => {
  const schema = operatorProposerContract.output_schema;
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
  ])
    assert.throws(() => validate(schema, output));
});

test('summaries have their own contract and require the ordered proposal results', () => {
  const { actions: _actions, ...missingActions } = summarize;
  validate(operatorSummarizerContract.input_schema, summarize);
  assert.throws(() =>
    validate(operatorSummarizerContract.input_schema, missingActions),
  );
  assert.throws(() =>
    validate(operatorProposerContract.input_schema, summarize),
  );
  const output = {
    action: 'summarize',
    historyRef: 'history',
    summaryRef: 'summary',
  };
  validate(operatorSummarizerContract.output_schema, output);
  assert.throws(() => validate(operatorProposerContract.output_schema, output));
  assert.throws(() =>
    validate(operatorSummarizerContract.output_schema, {
      ...output,
      historyRef: null,
    }),
  );
});
