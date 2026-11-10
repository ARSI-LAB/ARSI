import test from 'node:test';
import assert from 'node:assert/strict';
import {
  iterativeProposerContract,
  type IterativeProposerInput,
  type IterativeProposerOutput,
  type IterativeProposerWork,
} from '../../src/contracts/plugin-types/proposer-iterative.js';
import { validate } from '../../src/shared/schema.js';

const proposal = {
  status: 'no-change' as const,
  candidateRef: 'parent',
  diffRef: null,
  rationale: 'No change',
};

test('iterative proposers exchange evaluation and proposal work through one lifecycle', () => {
  const inputs: IterativeProposerInput[] = [
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
  for (const input of inputs)
    validate(iterativeProposerContract.input_schema, input);
  const works: (IterativeProposerWork | null)[] = [
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
  const output: IterativeProposerOutput = {
    stateRef: 'next-state',
    done: false,
    iterationLimit: null,
    work: null,
    result: null,
  };
  for (const work of works)
    validate(iterativeProposerContract.output_schema, { ...output, work });
  validate(iterativeProposerContract.output_schema, {
    ...output,
    done: true,
    iterationLimit: 2,
    result: { selected: 'parent' },
  });
});

test('iterative proposer boundaries reject algorithm state, private stages and incomplete work', () => {
  for (const extra of [{ settings: {} }, { state: {} }, { plan: {} }])
    assert.throws(
      () =>
        validate(iterativeProposerContract.input_schema, {
          action: 'suggest',
          stateRef: 'state',
          ...extra,
        }),
      /additional properties/,
    );
  for (const action of ['prepare', 'compare', 'select', 'observe-initial'])
    assert.throws(() =>
      validate(iterativeProposerContract.input_schema, {
        action,
        stateRef: 'state',
      }),
    );
  assert.throws(() =>
    validate(iterativeProposerContract.input_schema, {
      action: 'suggest',
      stateRef: '',
    }),
  );
  assert.throws(() =>
    validate(iterativeProposerContract.input_schema, {
      action: 'observe',
      stateRef: 'state',
      workId: 'work',
      feedback: { kind: 'evaluation' },
    }),
  );
  assert.throws(() =>
    validate(iterativeProposerContract.output_schema, {
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

test('iterative proposers validate optional paired task pools without a public dataset model', () => {
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
      validate(iterativeProposerContract.input_schema, {
        action: 'initialize',
        parent: 'parent',
        ...pools,
      }),
    );
});
