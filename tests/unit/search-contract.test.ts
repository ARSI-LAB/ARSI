import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchContract,
  type SearchInput,
  type SearchOutput,
  type SearchWork,
} from '../../src/contracts/plugin-types/search.js';
import { validate } from '../../src/shared/schema.js';

const proposal = {
  status: 'no-change' as const,
  candidateRef: 'parent',
  diffRef: null,
  rationale: 'No change',
};

test('stateful search exchanges evaluation and proposal work through one lifecycle', () => {
  const inputs: SearchInput[] = [
    { action: 'initialize', parent: 'parent' },
    {
      action: 'initialize',
      parent: 'parent',
      feedbackTaskIds: ['training'],
      selectionTaskIds: ['validation'],
    },
    { action: 'suggest', stateRef: 'state' },
    {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: {
        kind: 'evaluation',
        measurementRefs: ['measurement'],
        decisionRef: 'decision',
      },
    },
    {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: { kind: 'evaluation', measurementRefs: [] },
    },
    {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: {
        kind: 'proposal',
        parentMeasurementRefs: ['parent-measurement'],
        proposal,
        proposalMeasurementRef: null,
      },
    },
  ];
  for (const input of inputs) validate(searchContract.input_schema, input);
  const works: (SearchWork | null)[] = [
    null,
    { kind: 'evaluation', id: 'work', evaluations: [] },
    {
      kind: 'evaluation',
      id: 'work',
      evaluations: [{ candidateRef: 'candidate' }],
      parameters: { x: 1 },
    },
    {
      kind: 'evaluation',
      id: 'work',
      evaluations: [{ candidateRef: 'candidate', taskIds: ['task'] }],
    },
    {
      kind: 'proposal',
      id: 'work',
      parentRefs: ['parent'],
      taskIds: ['task'],
      proposalInput: {
        parent: 'parent',
        goal: 'Improve',
        evidenceRefs: [],
        editConstraints: {},
      },
      proposalResult: null,
    },
    {
      kind: 'proposal',
      id: 'work',
      parentRefs: ['parent'],
      taskIds: ['task'],
      proposalInput: null,
      proposalResult: proposal,
    },
  ];
  const output: SearchOutput = {
    stateRef: 'next-state',
    done: false,
    iterationLimit: null,
    work: null,
    result: null,
  };
  for (const work of works)
    validate(searchContract.output_schema, { ...output, work });
  validate(searchContract.output_schema, {
    ...output,
    done: true,
    iterationLimit: 2,
    result: { selected: 'parent' },
  });
});

test('search boundaries reject algorithm state, private stages and incomplete work', () => {
  for (const extra of [{ settings: {} }, { state: {} }, { plan: {} }])
    assert.throws(
      () =>
        validate(searchContract.input_schema, {
          action: 'suggest',
          stateRef: 'state',
          ...extra,
        }),
      /additional properties/,
    );
  for (const action of ['prepare', 'compare', 'select', 'observe-initial'])
    assert.throws(() =>
      validate(searchContract.input_schema, { action, stateRef: 'state' }),
    );
  assert.throws(() =>
    validate(searchContract.input_schema, { action: 'suggest', stateRef: '' }),
  );
  assert.throws(() =>
    validate(searchContract.input_schema, {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: { kind: 'evaluation' },
    }),
  );
  assert.throws(() =>
    validate(searchContract.input_schema, {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: {
        kind: 'proposal',
        parentMeasurementRefs: [],
        proposal: {
          status: 'batch',
          candidates: [
            { candidateRef: 'child', diffRef: 'diff', rationale: 'Change' },
          ],
        },
        proposalMeasurementRef: null,
      },
    }),
  );
  assert.throws(() =>
    validate(searchContract.output_schema, {
      stateRef: 'state',
      done: false,
      iterationLimit: 2,
      result: null,
      work: {
        kind: 'proposal',
        id: 'work',
        parentRefs: ['parent'],
        taskIds: ['task'],
        proposalInput: null,
        proposalResult: null,
      },
    }),
  );
});

test('search validates optional paired task pools without a public dataset model', () => {
  for (const pools of [
    { feedbackTaskIds: [], selectionTaskIds: ['validation'] },
    {
      feedbackTaskIds: ['training'],
      selectionTaskIds: ['validation', 'validation'],
    },
    { feedbackTaskIds: ['training'] },
    {
      dataset: {
        trainTaskIds: ['training'],
        validationTaskIds: ['validation'],
      },
    },
  ])
    assert.throws(() =>
      validate(searchContract.input_schema, {
        action: 'initialize',
        parent: 'parent',
        ...pools,
      }),
    );
});
