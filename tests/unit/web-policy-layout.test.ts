import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPolicyStructure } from '../../src/runtime/compiler/policy-structure.js';
import {
  focusedPolicyData,
  layoutPolicyData,
  layoutPolicyFlow,
  policyExpressionNavigation,
  policyExpressionReferences,
  revealPolicyStep,
} from '../../web/features/experiments/policy-layout.js';

test('expression navigation resolves exact root and nested declaration locations', () => {
  const model = projectPolicyStructure({
    experimentId: 'expression-links',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'expression-links',
      input: { item: '${{ application.initialCandidate }}' },
      state: { first: '${{ input.item }}' },
      steps: [
        {
          id: 'collect',
          type: 'foreach',
          foreach: '${{ config.items }}',
          as: 'item',
          key: '${{ item }}',
          steps: [],
          output: '${{ item }}',
        },
      ],
      output: '${{ steps.collect.output }}',
    },
    recipe: {
      policy: {
        config: { first: 'a', items: ['a', 'b'] },
        input: { item: '${{ config.first }}' },
      },
    },
  });
  const references = policyExpressionReferences(model);
  const nodes = new Map(model.data.nodes.map((node) => [node.id, node.kind]));
  const dependencies = (location: string) =>
    references
      .get(location)
      ?.map(({ source, target }) => [
        nodes.get(source.nodeId),
        nodes.get(target.nodeId),
      ]);
  assert.deepEqual(dependencies('/input/item'), [['application', 'input']]);
  assert.deepEqual(dependencies('/recipe/policy/input/item'), [
    ['config', 'input'],
  ]);
  assert.deepEqual(dependencies('/state/first'), [['input', 'state']]);
  assert.deepEqual(dependencies('/steps/0/foreach'), [['config', 'step']]);
  assert.deepEqual(dependencies('/steps/0/output'), [['item', 'step']]);
  assert.deepEqual(dependencies('/output'), [['step', 'output']]);
});

function fixture(): ReturnType<typeof projectPolicyStructure> {
  return projectPolicyStructure({
    experimentId: 'layout-fixture',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'layout-fixture',
      require: {},
      input: {},
      state: { value: 0 },
      steps: [
        { id: 'before', type: 'state', state: { value: 1 } },
        {
          id: 'loop',
          type: 'loop',
          maxIterations: 3,
          steps: [
            {
              id: 'choose',
              type: 'if',
              if: '${{ state.value > 0 }}',
              then: {
                steps: [
                  {
                    id: 'local',
                    type: 'state',
                    state: { value: '${{ input.items[loop.index] }}' },
                  },
                ],
              },
              else: { steps: [] },
            },
            { id: 'stop', type: 'control', control: 'break' },
          ],
        },
        { id: 'after', type: 'state', state: { result: '${{ state.value }}' } },
        {
          id: 'second',
          type: 'loop',
          maxIterations: 1,
          steps: [{ id: 'local', type: 'state', state: { value: 2 } }],
        },
      ],
      output: '${{ state.result }}',
    },
    recipe: { policy: { config: {}, input: { items: [1, 2] } }, bindings: {} },
  });
}

test('flow starts at top-level and preserves compound fall-through and break exits when expanded or collapsed', () => {
  const model = fixture();
  assert.equal(model.availability.flow, 'complete');
  const loop = model.steps.find((step) => step.localId === 'loop')!;
  const after = model.steps.find((step) => step.localId === 'after')!;
  const stop = model.steps.find((step) => step.localId === 'stop')!;
  const exit = model.flow.nodes.find(
    (node) => node.stepId === loop.id && node.kind === 'exit',
  )!;
  const collapsed = layoutPolicyFlow(model, new Set());
  assert.equal(
    collapsed.nodes.filter((node) =>
      model.steps.some((step) => step.id === node.id),
    ).length,
    4,
  );
  assert.ok(
    collapsed.edges.some(
      (edge) => edge.sourceId === loop.id && edge.targetId === after.id,
    ),
  );
  const expanded = layoutPolicyFlow(model, new Set([loop.id]));
  assert.ok(expanded.nodes.some((node) => node.id === exit.id));
  assert.ok(
    expanded.edges.some(
      (edge) => edge.sourceId === exit.id && edge.targetId === after.id,
    ),
  );
  assert.ok(
    expanded.edges.some(
      (edge) =>
        edge.sourceId === stop.id &&
        edge.targetId === exit.id &&
        edge.kind === 'break',
    ),
  );
  const parent = expanded.nodes.find((node) => node.id === loop.id)!;
  const child = expanded.nodes.find((node) => node.id === stop.id)!;
  assert.ok(
    child.x > parent.x &&
      child.y > parent.y &&
      child.y + child.height < parent.y + parent.height,
  );
  assert.ok(
    expanded.nodes.find((node) => node.id === after.id)!.y >
      parent.y + parent.height,
  );
});

test('cross-view reveal opens only scoped ancestors and preserves unrelated expansion', () => {
  const model = fixture();
  const locals = model.steps.filter((step) => step.localId === 'local');
  const loop = model.steps.find((step) => step.localId === 'loop')!;
  const choose = model.steps.find((step) => step.localId === 'choose')!;
  const second = model.steps.find((step) => step.localId === 'second')!;
  assert.equal(locals.length, 2);
  const expansion = revealPolicyStep(
    model,
    locals[0]!.id,
    new Set([second.id]),
  );
  assert.deepEqual(expansion, new Set([second.id, choose.id, loop.id]));
  const layout = layoutPolicyFlow(model, expansion);
  assert.ok(layout.nodes.some((node) => node.id === locals[0]!.id));
  assert.ok(
    layout.regions.some((region) => region.label === 'else' && region.empty),
  );
});

test('input and output cards bracket the root flow and preserve nested anchors', () => {
  const model = fixture();
  const root = model.scopes.find((scope) => scope.region === 'root')!;
  const loop = model.steps.find((step) => step.localId === 'loop')!;
  const layout = layoutPolicyFlow(model, new Set([loop.id]));
  const input = layout.nodes.find((node) => node.id === root.entryId)!;
  const output = layout.nodes.find((node) => node.id === root.exitId)!;
  assert.deepEqual(
    layout.nodes
      .filter((node) => node.dataNodeId)
      .map((node) => [node.id, node.dataNodeId]),
    [
      [
        root.entryId,
        model.data.nodes.find((node) => node.kind === 'input')!.id,
      ],
      [
        root.exitId,
        model.data.nodes.find((node) => node.kind === 'output')!.id,
      ],
    ],
  );
  const first = layout.nodes.find((node) => node.id === root.stepIds[0])!;
  const last = layout.nodes.find((node) => node.id === root.stepIds.at(-1))!;
  assert.ok(input.width > 20 && input.height > 20);
  assert.ok(output.width > 20 && output.height > 20);
  assert.ok(input.y + input.height < first.y);
  assert.ok(last.y + last.height < output.y);
  const iteration = model.scopes.find(
    (scope) => scope.parentStepId === loop.id,
  )!;
  for (const id of [iteration.entryId, iteration.exitId]) {
    const anchor = layout.nodes.find((node) => node.id === id)!;
    assert.equal(anchor.width, 20);
    assert.equal(anchor.height, 20);
  }
  assert.ok(
    layout.edges.some(
      (edge) => edge.sourceId === input.id && edge.targetId === first.id,
    ),
  );
  assert.ok(
    layout.edges.some(
      (edge) => edge.sourceId === last.id && edge.targetId === output.id,
    ),
  );
});

test('empty flow connects the root input and output cards across a visible gap', () => {
  const model = projectPolicyStructure({
    experimentId: 'empty-flow',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'empty-flow',
      input: { value: 1 },
      steps: [],
      output: '${{ input.value }}',
    },
    recipe: {},
  });
  const layout = layoutPolicyFlow(model, new Set());
  assert.equal(layout.nodes.length, 2);
  const [input, output] = layout.nodes;
  assert.ok(input?.dataNodeId && output?.dataNodeId);
  assert.ok(input.y + input.height < output.y);
  assert.ok(output.y + output.height < layout.height);
  assert.deepEqual(
    layout.edges.map((edge) => [edge.id, edge.sourceId, edge.targetId]),
    [[model.flow.edges[0]!.id, input.id, output.id]],
  );
});

test('focused data connects Policy Input and Output through the focus and matching state fields', () => {
  const model = fixture();
  const after = model.steps.find((step) => step.localId === 'after')!;
  const before = model.steps.find((step) => step.localId === 'before')!;
  const local = model.steps.find((step) => step.localId === 'local')!;
  const input = model.data.nodes.find((node) => node.kind === 'input')!;
  const output = model.data.nodes.find((node) => node.kind === 'output')!;
  const state = model.data.nodes.find((node) => node.kind === 'state')!;
  const focused = focusedPolicyData(model, after.id);
  assert.ok(!focused.nodes.some((node) => node.id === before.id));
  assert.deepEqual(
    focused.edges.map((edge) => [edge.source.nodeId, edge.target.nodeId]),
    [
      [input.id, local.id],
      [local.id, state.id],
      [state.id, after.id],
      [after.id, state.id],
      [state.id, output.id],
    ],
  );
  const localData = focusedPolicyData(model, local.id);
  assert.ok(localData.edges.some((edge) => edge.dynamic));
  assert.ok(localData.nodes.some((node) => node.kind === 'loop'));
});

test('focused data preserves an independent Policy path without bridging unrelated state fields', () => {
  const model = projectPolicyStructure({
    experimentId: 'independent-focus',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'independent-focus',
      state: { result: 0, other: '${{ input.value }}' },
      steps: [
        { id: 'update', type: 'state', state: { other: 1 } },
        {
          id: 'ingest',
          type: 'state',
          state: { other: '${{ input.value }}', result: 42 },
        },
        {
          id: 'publish',
          type: 'state',
          state: { result: '${{ input.value }}' },
        },
      ],
      output: '${{ state.result }}',
    },
    recipe: { policy: { input: { value: 1 } } },
  });
  const focus = model.steps.find((step) => step.localId === 'update')!;
  const focused = focusedPolicyData(model, focus.id);
  assert.deepEqual(
    focused.edges.map((edge) => edge.location),
    [
      '/steps/0/state/other',
      '/steps/2/state/result',
      '/steps/2/state/result',
      '/output',
    ],
  );
  const input = focused.nodes.find((node) => node.kind === 'input')!;
  const output = focused.nodes.find((node) => node.kind === 'output')!;

  // A literal output has no dependency edge, but still brackets the focus.
  model.data.edges = model.data.edges.filter(
    (edge) => edge.location !== '/output',
  );
  const isolated = focusedPolicyData(model, focus.id);
  assert.deepEqual(
    isolated.edges.map((edge) => edge.location),
    ['/steps/0/state/other'],
  );
  const layout = layoutPolicyData(isolated, focus.id);
  const x = (id: string): number =>
    layout.nodes.find((node) => node.id === id)!.x;
  assert.ok(x(input.id) < x(focus.id) && x(focus.id) < x(output.id));
});

test('focused state expressions include their written field and its declared readers', () => {
  const model = projectPolicyStructure({
    experimentId: 'state-write-focus',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'state-write-focus',
      state: { 'queue/active': { items: [] }, other: 0 },
      steps: [
        {
          id: 'write',
          type: 'state',
          state: {
            'queue/active': {
              items: ['${{ input.values[input.index] }}', '${{ 1 + 2 }}'],
            },
            other: "${{ size(state['queue/active'].items) }}",
          },
        },
        {
          id: 'read',
          type: 'state',
          state: { item: "${{ state['queue/active'].items[input.index] }}" },
        },
        {
          id: 'replace',
          type: 'state',
          state: { 'queue/active': { items: [] } },
        },
      ],
      output: {
        exact: "${{ state['queue/active'] }}",
        nested: "${{ state['queue/active'].items[0] }}",
        whole: '${{ state }}',
        other: '${{ state.other }}',
      },
    },
    recipe: { policy: { input: { values: [1], index: 0 } } },
  });
  const navigation = policyExpressionNavigation(model);
  const field = '/steps/0/state/queue~1active';
  const location = `${field}/items/0`;
  const selection = navigation.focus(location)!;
  assert.equal(selection.writesState, true);
  const focused = focusedPolicyData(
    model,
    selection.target.nodeId,
    selection.edges,
  );
  assert.ok(focused.nodes.some((node) => node.kind === 'output'));
  assert.ok(focused.nodes.some((node) => node.label === 'read'));
  assert.ok(!focused.nodes.some((node) => node.label === 'replace'));
  const highlighted = focused.edges
    .filter((edge) => selection.edges.has(edge.id))
    .map((edge) => `${edge.kind} ${edge.location}`)
    .sort();
  assert.deepEqual(highlighted, [
    'output-mapping /output/exact',
    'output-mapping /output/nested',
    'output-mapping /output/whole',
    `reference ${location}`,
    `reference ${location}`,
    'reference /steps/1/state/item',
    `state-write ${field}`,
  ]);
  const write = model.data.edges.find(
    (edge) => edge.kind === 'state-write' && edge.location === field,
  )!;
  assert.ok(selection.ports.has(write.target.portId));

  const constant = `${field}/items/1`;
  assert.ok(navigation.canFocus(constant, '${{ 1 + 2 }}'));
  assert.ok(!navigation.canFocus(constant, 'plain text'));
  assert.deepEqual(navigation.focus(constant)?.target, write.source);
  assert.equal(navigation.focus(constant)?.edges.size, highlighted.length - 2);
});

test('focused state reads include writes and initialization for overlapping fields', () => {
  const model = projectPolicyStructure({
    experimentId: 'state-read-focus',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'state-read-focus',
      state: {
        pool: { active: '${{ input.seed }}', standby: '${{ input.backup }}' },
      },
      steps: [
        { id: 'first', type: 'state', state: { pool: {} } },
        { id: 'archive', type: 'state', state: { poolArchive: {} } },
        {
          id: 'inspect',
          type: 'if',
          if: '${{ state.pool.active.jobs == null }}',
          then: { steps: [] },
        },
        {
          id: 'refresh',
          type: 'state',
          state: { pool: {}, previous: '${{ state.pool.active.jobs }}' },
        },
      ],
      output: '${{ state }}',
    },
    recipe: { policy: { input: { seed: { jobs: [] }, backup: {} } } },
  });
  const navigation = policyExpressionNavigation(model);
  const selection = navigation.focus('/steps/2/if')!;
  const focused = focusedPolicyData(
    model,
    selection.target.nodeId,
    selection.edges,
  );
  assert.deepEqual(
    focused.edges
      .filter((edge) => selection.edges.has(edge.id))
      .map((edge) => edge.location),
    [
      '/state/pool/active',
      '/steps/0/state/pool',
      '/steps/2/if',
      '/steps/3/state/pool',
    ],
  );
  const state = focused.nodes.find((node) => node.kind === 'state')!;
  assert.deepEqual(
    state.ports
      .filter((port) => selection.ports.has(port.id))
      .map((port) => port.path),
    [['pool', 'active'], ['pool'], ['pool', 'active', 'jobs']],
  );

  const refresh = navigation.focus('/steps/3/state/previous')!;
  const writes = model.data.edges.filter((edge) => edge.kind === 'state-write');
  assert.deepEqual(
    writes
      .filter((edge) => refresh.edges.has(edge.id))
      .map((edge) => edge.location),
    ['/steps/0/state/pool', '/steps/3/state/previous'],
  );
  const whole = navigation.focus('/output')!;
  assert.ok(writes.every((edge) => whole.edges.has(edge.id)));
});

test('data layout retains cyclic relationships, field ports and edge direction without overlaps', () => {
  const model = fixture();
  const layout = layoutPolicyData(model.data);
  assert.equal(layout.nodes.length, model.data.nodes.length);
  assert.equal(layout.edges.length, model.data.edges.length);
  for (const [index, edge] of model.data.edges.entries()) {
    assert.equal(layout.edges[index]!.sourceId, edge.source.nodeId);
    assert.equal(layout.edges[index]!.targetId, edge.target.nodeId);
    assert.ok(!layout.edges[index]!.path.includes('NaN'));
  }
  assert.ok(
    layout.edges.some((edge) => edge.dynamic && edge.label.includes('dynamic')),
  );
  for (const a of layout.nodes) {
    assert.ok(
      a.x >= 0 &&
        a.y >= 0 &&
        a.x + a.width <= layout.width &&
        a.y + a.height <= layout.height,
    );
    for (const b of layout.nodes) {
      if (a.id === b.id) continue;
      assert.ok(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      );
    }
  }
});
