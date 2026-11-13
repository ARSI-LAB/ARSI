import assert from 'node:assert/strict';
import test from 'node:test';
import { describePolicyExpression } from '../../web/features/experiments/policy-expression-description.js';

test('describes append and range using the declared operands', () => {
  assert.deepEqual(
    describePolicyExpression(
      '${{ append(state.deliveries, steps.select.output) }}',
    ),
    { text: 'Add steps.select.output to the end of state.deliveries' },
  );
  assert.deepEqual(
    describePolicyExpression('${{ range(0, item.count) }}', ['item']),
    { text: 'Start at 0, stop before item.count' },
  );
});

test('discloses a joined list used as an operand', () => {
  assert.deepEqual(
    describePolicyExpression(
      '${{ append(concat(input.first, input.second), input.item) }}',
    ),
    {
      text: 'Add input.item to the end of the list below',
      operands: [
        {
          label: 'List',
          description: { text: 'Join input.first and input.second in order' },
        },
      ],
    },
  );
});

test('describes nested joins in operand order for either grouping', () => {
  for (const value of [
    '${{ concat(concat(input.first, config.middle), state.last) }}',
    '${{ concat(input.first, concat(config.middle, state.last)) }}',
  ]) {
    assert.deepEqual(describePolicyExpression(value), {
      text: 'Join input.first, config.middle, and state.last in order',
    });
  }
});

test('keeps nested call positions and quotes bracket property names', () => {
  assert.deepEqual(
    describePolicyExpression(
      '${{ concat(append(range(-1, input.count), input.values["first.item"][0]), state.saved) }}',
    ),
    {
      text: 'Join list 1 below and state.saved in order',
      operands: [
        {
          label: 'List 1',
          description: {
            text: 'Add input.values["first.item"][0] to the end of the list below',
            operands: [
              {
                label: 'List',
                description: { text: 'Start at -1, stop before input.count' },
              },
            ],
          },
        },
      ],
    },
  );
});

test('distinguishes range bounds and retains nested operator direction', () => {
  assert.deepEqual(
    describePolicyExpression(
      '${{ range(input.start, input.end - size(append(state.results, input.extra))) }}',
    ),
    {
      text: 'Start at input.start, stop before the end value below',
      operands: [
        {
          label: 'End (excluded)',
          description: {
            text: '(input.end - right operand below)',
            operands: [
              {
                label: 'Right operand',
                description: {
                  text: 'Count the items in the list below',
                  operands: [
                    {
                      label: 'List',
                      description: {
                        text: 'Add input.extra to the end of state.results',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  );
});

test('describes collection, lookup, and conditional operations', () => {
  for (const [value, text] of [
    ['${{ length(input.items) }}', 'Count the items in input.items'],
    [
      '${{ flatten(input.groups) }}',
      'Join the lists inside input.groups in order',
    ],
    ['${{ compact(state.items) }}', 'Remove null entries from state.items'],
    [
      '${{ get(input.items, 0, null) }}',
      'Read 0 from input.items, or use null if it is missing',
    ],
    [
      '${{ pluck(input.items, "id") }}',
      'Read "id" from each item in input.items',
    ],
    [
      '${{ some(input.items, "ready", true) }}',
      'Check whether any item in input.items has "ready" equal to true',
    ],
    [
      '${{ if(input.ready, input.items, state.saved) }}',
      'If input.ready, use input.items, otherwise use state.saved',
    ],
    [
      '${{ input.ready ? input.items : state.saved }}',
      'If input.ready, use input.items, otherwise use state.saved',
    ],
  ] as const) {
    assert.deepEqual(describePolicyExpression(value), { text });
  }
});

test('leaves unrelated, literal, and invalid expressions unchanged', () => {
  for (const value of [
    'range(0, 4)',
    '${{ state.items[0] }}',
    '${{ "append(state.items, 2)" }}',
    '${{ append(state.items) }}',
    '${{ concat(input.items) }}',
    '${{ unsupported(input.items) }}',
  ]) {
    assert.equal(describePolicyExpression(value), undefined);
  }
});
