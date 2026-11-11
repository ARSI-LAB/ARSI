import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPolicyStructure } from '../../src/runtime/compiler/policy-structure.js';
import {
  focusedPolicyData,
  layoutPolicyData,
  layoutPolicyFlow,
  revealPolicyStep,
} from '../../web/features/experiments/policy-layout.js';

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

test('focused data retains direct fields and dynamic accesses without adding state writers', () => {
  const model = fixture();
  const after = model.steps.find((step) => step.localId === 'after')!;
  const before = model.steps.find((step) => step.localId === 'before')!;
  const focused = focusedPolicyData(model, after.id);
  assert.ok(focused.nodes.some((node) => node.kind === 'state'));
  assert.ok(!focused.nodes.some((node) => node.id === before.id));
  assert.ok(
    focused.edges.every(
      (edge) =>
        edge.source.nodeId === after.id || edge.target.nodeId === after.id,
    ),
  );
  const local = model.steps.find((step) => step.localId === 'local')!;
  const localData = focusedPolicyData(model, local.id);
  assert.ok(localData.edges.some((edge) => edge.dynamic));
  assert.ok(localData.nodes.some((node) => node.kind === 'loop'));
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
