import test from 'node:test';
import assert from 'node:assert/strict';
import { populationSearchContract } from '../../src/contracts/plugin-types/population-search.js';
import type {
  PopulationSearchInput,
  PopulationSearchOutput,
} from '../../src/contracts/plugin-types/population-search.js';
import { validate } from '../../src/shared/schema.js';

test('population search exchanges work and opaque state without algorithm settings', () => {
  const proposal = {
    status: 'no-change' as const,
    candidateRef: 'parent',
    diffRef: null,
    rationale: 'No change',
  };
  const inputs: PopulationSearchInput[] = [
    {
      action: 'initialize',
      candidateRef: 'parent',
      dataset: {
        trainTaskIds: ['training'],
        validationTaskIds: ['validation'],
      },
    },
    { action: 'observe-initial', stateRef: 'state', measurementRef: null },
    { action: 'prepare', stateRef: 'state' },
    {
      action: 'compare',
      stateRef: 'state',
      parentMeasurementRefs: ['parent-measurement'],
      proposal,
      proposalMeasurementRef: null,
    },
    { action: 'select', stateRef: 'state', measurementRef: 'measurement' },
  ];
  for (const input of inputs)
    validate(populationSearchContract.input_schema, input);
  const output: PopulationSearchOutput = {
    stateRef: 'next-state',
    done: false,
    iterationLimit: 2,
    evaluation: { candidateRef: 'parent', taskIds: ['task'] },
    plan: {
      parentRefs: ['parent'],
      taskIds: ['task'],
      proposalInput: {
        parent: 'parent',
        goal: 'Improve the candidate',
        editConstraints: {},
      },
      proposalResult: null,
    },
    result: null,
  };
  validate(populationSearchContract.output_schema, output);
  validate(populationSearchContract.output_schema, {
    ...output,
    done: true,
    evaluation: null,
    plan: null,
    result: { selected: 'parent' },
  });
  validate(populationSearchContract.output_schema, {
    ...output,
    plan: { ...output.plan, proposalInput: null, proposalResult: proposal },
  });
  for (const extra of [{ settings: {} }, { state: {} }, { plan: {} }])
    assert.throws(
      () =>
        validate(populationSearchContract.input_schema, {
          action: 'prepare',
          stateRef: 'state',
          ...extra,
        }),
      /additional properties/,
    );
  assert.throws(
    () =>
      validate(populationSearchContract.input_schema, {
        action: 'prepare',
        stateRef: '',
      }),
    /fewer than 1 characters/,
  );
  assert.throws(
    () =>
      validate(populationSearchContract.output_schema, {
        ...output,
        plan: { ...output.plan, report: {} },
      }),
    /additional properties/,
  );
});

test('population search validates the initialization dataset before execution', () => {
  for (const dataset of [
    { trainTaskIds: [], validationTaskIds: ['validation'] },
    {
      trainTaskIds: ['training'],
      validationTaskIds: ['validation', 'validation'],
    },
    { trainTaskIds: ['training'] },
  ])
    assert.throws(() =>
      validate(populationSearchContract.input_schema, {
        action: 'initialize',
        candidateRef: 'parent',
        dataset,
      }),
    );
});
