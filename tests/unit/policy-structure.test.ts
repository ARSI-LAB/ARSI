import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/contracts/json.js';
import type {
  PolicyStructure,
  StructureDataNode,
} from '../../src/contracts/policy-structure.js';
import {
  policyStructureLimits,
  projectPolicyStructure,
} from '../../src/runtime/compiler/policy-structure.js';

function project(
  steps: JsonValue[],
  overrides: JsonObject = {},
): PolicyStructure {
  return projectPolicyStructure({
    experimentId: 'fixture',
    definitionDigest: 'saved-digest',
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'fixture-policy',
      input: {},
      state: {},
      require: { worker: { contract: 'contract.fixture' } },
      steps,
      output: null,
      ...overrides,
    },
    recipe: {
      policy: { config: { count: 3, flag: true }, input: { seed: 0 } },
      bindings: {
        worker: {
          plugin: 'plugin.saved',
          config: { literal: '${{ not.a.policy.expression }}' },
        },
      },
    },
    reflection: { initial: 'saved-reflection' },
  });
}
function node(
  model: PolicyStructure,
  kind: StructureDataNode['kind'],
): StructureDataNode {
  return model.data.nodes.find((entry) => entry.kind === kind)!;
}
function invoke(id: string, input: JsonValue = {}): JsonObject {
  return { id, type: 'invoke', use: 'worker', with: input };
}

test('all seven step kinds retain scoped identities, empty branches and saved binding details', () => {
  const model = project(
    [
      invoke('seed', '${{ application.baseline }}'),
      {
        id: 'save',
        type: 'state',
        state: { best: '${{ steps.seed.output }}' },
      },
      {
        id: 'choose',
        type: 'if',
        if: '${{ config.flag }}',
        then: { steps: [invoke('local')], output: '${{ steps.local.output }}' },
        else: { steps: [], output: null },
      },
      {
        id: 'repeat',
        type: 'loop',
        maxIterations: '${{ config.count }}',
        steps: [{ id: 'stop', type: 'control', control: 'break' }],
        output: '${{ state.best }}',
      },
      {
        id: 'map',
        type: 'foreach',
        foreach: '${{ input.items }}',
        as: 'row',
        key: '${{ row.id }}',
        concurrency: 2,
        steps: [invoke('local', '${{ row }}')],
        output: '${{ steps.local.output }}',
      },
      { id: 'reflect', type: 'reflection' },
    ],
    {
      input: { count: '${{ config.count }}' },
      state: { best: '${{ input.seed }}' },
      output: '${{ steps.map.output }}',
    },
  );
  assert.equal(model.availability.overall, 'complete');
  assert.deepEqual(
    new Set(model.steps.map((step) => step.type)),
    new Set([
      'invoke',
      'state',
      'if',
      'loop',
      'foreach',
      'control',
      'reflection',
    ]),
  );
  const locals = model.steps.filter((step) => step.localId === 'local');
  assert.equal(locals.length, 2);
  assert.notEqual(locals[0]!.id, locals[1]!.id);
  assert.notEqual(locals[0]!.scopeId, locals[1]!.scopeId);
  const empty = model.scopes.find((scope) => scope.region === 'else')!;
  assert.equal(empty.stepIds.length, 0);
  assert.ok(
    model.flow.edges.some(
      (edge) => edge.source === empty.entryId && edge.target === empty.exitId,
    ),
  );
  const detail = model.details.find(
    (detail) => detail.id === model.steps[0]!.detailId,
  )!;
  const binding = model.bindings.find(
    (entry) => entry.id === detail.bindingId,
  )!;
  assert.equal(binding.plugin, 'plugin.saved');
  assert.deepEqual(binding.configuration, {
    literal: '${{ not.a.policy.expression }}',
  });
  assert.equal(binding.contract, 'contract.fixture');
});

test('references preserve conditional alternatives, whole objects, static and dynamic accesses and index sources', () => {
  const model = project([
    {
      id: 'repeat',
      type: 'loop',
      maxIterations: 2,
      while: '${{ loop.index < config.count }}',
      steps: [
        invoke('consume', {
          selected: '${{ if(config.flag, input.left, input.right) }}',
          dynamic: '${{ input.items[loop.index].payload }}',
          static: '${{ input.items[0].payload }}',
          whole: '${{ input }}',
          short: '${{ config.flag && input.enabled }}',
          source: '${{ application.baseline }}',
        }),
      ],
      output: null,
    },
  ]);
  assert.equal(model.availability.overall, 'complete');
  const input = node(model, 'input');
  assert.ok(input.ports.some((port) => port.path.join('.') === 'left'));
  assert.ok(input.ports.some((port) => port.path.join('.') === 'right'));
  assert.ok(
    input.ports.some((port) => port.path.join('.') === 'items.0.payload'),
  );
  assert.ok(input.ports.some((port) => port.path.length === 0));
  const dynamic = model.data.edges.find((edge) => edge.dynamic)!;
  assert.equal(dynamic.source.nodeId, input.id);
  assert.deepEqual(
    input.ports.find((port) => port.id === dynamic.source.portId)!.path,
    ['items'],
  );
  assert.ok(
    !input.ports.some(
      (port) =>
        port.path.includes('loop') || port.path.join('.') === 'items.payload',
    ),
  );
  const loop = node(model, 'loop');
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.source.nodeId === loop.id &&
        edge.target.portId === dynamic.target.portId &&
        edge.dynamic === false,
    ),
  );
  assert.ok(
    model.data.edges.some(
      (edge) => edge.source.nodeId === node(model, 'application').id,
    ),
  );
});

test('nested loop context sources resolve to their declaring scopes and loop outputs use outer frames', () => {
  const model = project([
    invoke('seed'),
    {
      id: 'outer',
      type: 'loop',
      maxIterations: 2,
      steps: [
        invoke('before', '${{ loop.index }}'),
        {
          id: 'inner',
          type: 'loop',
          maxIterations: '${{ loop.index + 1 }}',
          while: '${{ loop.index < 3 }}',
          steps: [invoke('inside', '${{ loop.index }}')],
          output: '${{ steps.before.output }}',
        },
        invoke('after', '${{ loop.index }}'),
      ],
      output: '${{ steps.seed.output }}',
    },
  ]);
  assert.equal(model.availability.overall, 'complete');
  const loops = model.data.nodes.filter((entry) => entry.kind === 'loop');
  assert.equal(loops.length, 2);
  const before = model.steps.find((entry) => entry.localId === 'before')!;
  const inside = model.steps.find((entry) => entry.localId === 'inside')!;
  const after = model.steps.find((entry) => entry.localId === 'after')!;
  const sourceOf = (target: string): string =>
    model.data.edges.find(
      (edge) =>
        edge.target.nodeId === target &&
        loops.some((loop) => loop.id === edge.source.nodeId),
    )!.source.nodeId;
  assert.equal(sourceOf(before.id), sourceOf(after.id));
  assert.notEqual(sourceOf(before.id), sourceOf(inside.id));
  const outer = model.steps.find((entry) => entry.localId === 'outer')!;
  const seed = model.steps.find((entry) => entry.localId === 'seed')!;
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.source.nodeId === seed.id &&
        edge.target.nodeId === outer.id &&
        edge.kind === 'output-mapping',
    ),
  );
  assert.ok(
    !model.data.edges.some(
      (edge) =>
        edge.source.nodeId === after.id && edge.target.nodeId === outer.id,
    ),
  );
});

test('compound boundaries retain branch mappings and symbolic per-item collection outputs', () => {
  const model = project([
    {
      id: 'choose',
      type: 'if',
      if: true,
      then: {
        steps: [invoke('producer')],
        output: { value: '${{ steps.producer.output.score }}' },
      },
      else: {
        steps: [invoke('producer')],
        output: { value: '${{ steps.producer.output.other }}' },
      },
    },
    invoke('consumer', '${{ steps.choose.output.value }}'),
    {
      id: 'map',
      type: 'foreach',
      foreach: '${{ input.rows }}',
      as: 'row',
      key: '${{ row.id }}',
      steps: [invoke('producer', '${{ row.value }}')],
      output: { score: '${{ steps.producer.output }}' },
    },
    invoke('collection', '${{ steps.map.output }}'),
  ]);
  assert.equal(model.availability.overall, 'complete');
  const choose = model.steps.find((step) => step.localId === 'choose')!;
  const consumer = model.steps.find((step) => step.localId === 'consumer')!;
  assert.deepEqual(
    new Set(
      model.data.edges
        .filter(
          (edge) =>
            edge.target.nodeId === choose.id && edge.kind === 'output-mapping',
        )
        .map((edge) => edge.label),
    ),
    new Set(['then', 'else']),
  );
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.source.nodeId === choose.id && edge.target.nodeId === consumer.id,
    ),
  );
  assert.ok(
    !model.data.edges.some(
      (edge) =>
        edge.target.nodeId === consumer.id &&
        model.steps.find((step) => step.id === edge.source.nodeId)?.localId ===
          'producer',
    ),
  );
  const map = model.steps.find((step) => step.localId === 'map')!;
  const output = model.data.nodes.find((entry) => entry.id === map.id)!;
  assert.ok(output.ports.some((port) => port.label === 'output (collection)'));
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.source.nodeId === map.id &&
        edge.target.nodeId === map.id &&
        edge.label === 'collect per-item outputs',
    ),
  );
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.kind === 'item-binding' &&
        edge.target.nodeId === node(model, 'item').id,
    ),
  );
});

test('shared state reads and writes remain separate without choosing a writer', () => {
  const model = project(
    [
      { id: 'write', type: 'state', state: { best: '${{ input.seed }}' } },
      invoke('read', '${{ state.best }}'),
      { id: 'writeAgain', type: 'state', state: { best: 42 } },
    ],
    { state: { best: '${{ input.initial }}' } },
  );
  const state = node(model, 'state');
  const reader = model.steps.find((step) => step.localId === 'read')!;
  assert.equal(
    model.data.edges.filter(
      (edge) => edge.target.nodeId === state.id && edge.kind === 'state-write',
    ).length,
    2,
  );
  assert.ok(
    model.data.edges.some(
      (edge) =>
        edge.source.nodeId === state.id && edge.target.nodeId === reader.id,
    ),
  );
  assert.ok(
    !model.data.edges.some(
      (edge) =>
        edge.target.nodeId === reader.id &&
        model.steps.some((step) => step.id === edge.source.nodeId),
    ),
  );
});

test('break, continue and fail have structural targets and no normal fall-through', () => {
  const model = project([
    {
      id: 'repeat',
      type: 'loop',
      maxIterations: 3,
      steps: [
        {
          id: 'choose',
          type: 'if',
          if: true,
          then: {
            steps: [{ id: 'stop', type: 'control', control: 'break' }],
            output: null,
          },
          else: {
            steps: [{ id: 'skip', type: 'control', control: 'continue' }],
            output: null,
          },
        },
        {
          id: 'fail',
          type: 'control',
          control: 'fail',
          reason: '${{ input.reason }}',
        },
        invoke('unreachable'),
      ],
      output: null,
    },
  ]);
  const loop = model.steps.find((step) => step.localId === 'repeat')!;
  for (const control of model.steps.filter((step) => step.type === 'control')) {
    const outgoing = model.flow.edges.filter(
      (edge) => edge.source === control.id,
    );
    assert.equal(outgoing.length, 1);
    assert.notEqual(outgoing[0]!.kind, 'sequence');
    if (outgoing[0]!.kind === 'continue')
      assert.equal(outgoing[0]!.target, loop.id);
    if (outgoing[0]!.kind === 'break')
      assert.equal(outgoing[0]!.target, `${loop.id}/$exit`);
    if (outgoing[0]!.kind === 'fail')
      assert.ok(
        model.flow.nodes.some(
          (node) => node.id === outgoing[0]!.target && node.kind === 'failure',
        ),
      );
  }
  const invalid = project([
    {
      id: 'outer',
      type: 'loop',
      maxIterations: 1,
      steps: [
        {
          id: 'map',
          type: 'foreach',
          foreach: [],
          as: 'row',
          key: '${{ row }}',
          steps: [{ id: 'bad', type: 'control', control: 'break' }],
        },
      ],
    },
  ]);
  assert.equal(invalid.availability.flow, 'partial');
  assert.ok(
    invalid.diagnostics.some((diagnostic) =>
      diagnostic.location?.endsWith('/control'),
    ),
  );
});

test('lexically shadowed unavailable outputs yield scoped partial data rather than invented producers', () => {
  const model = project([
    invoke('same'),
    {
      id: 'branch',
      type: 'if',
      if: true,
      then: {
        steps: [invoke('reader', '${{ steps.same.output }}'), invoke('same')],
        output: null,
      },
    },
  ]);
  assert.equal(model.availability.flow, 'complete');
  assert.equal(model.availability.data, 'partial');
  const reader = model.steps.find((step) => step.localId === 'reader')!;
  assert.ok(
    model.diagnostics.some(
      (diagnostic) =>
        diagnostic.nodeId === reader.id &&
        diagnostic.location === `${reader.location}/with`,
    ),
  );
  assert.ok(!model.data.edges.some((edge) => edge.target.nodeId === reader.id));
});

test('malformed expression isolates data failure and never exposes parser error text', () => {
  const model = project([
    invoke('broken', '${{ input.value + secret-text }}'),
    invoke('good', '${{ input.safe }}'),
  ]);
  assert.equal(model.availability.overall, 'partial');
  assert.equal(model.availability.flow, 'complete');
  assert.equal(model.availability.data, 'partial');
  assert.ok(
    model.data.edges.some((edge) => edge.target.nodeId === model.steps[1]!.id),
  );
  assert.ok(!JSON.stringify(model.diagnostics).includes('secret-text'));
});

test('unsupported structures and size limits return unavailable without a partial graph', () => {
  const unsupported = project([{ id: 'future', type: 'unknown' }]);
  assert.equal(unsupported.availability.overall, 'unavailable');
  assert.equal(unsupported.steps.length, 0);
  const oversized = project(
    Array.from({ length: policyStructureLimits.steps + 1 }, (_, index) =>
      invoke(`step${index}`),
    ),
  );
  assert.equal(oversized.diagnostics[0]!.category, 'oversized');
  assert.equal(oversized.availability.overall, 'unavailable');
  assert.equal(oversized.steps.length, 0);
  assert.equal(oversized.data.edges.length, 0);
});

test('projection identities are deterministic and change with the saved definition identity', () => {
  const first = project([invoke('one')]);
  assert.deepEqual(project([invoke('one')]), first);
  assert.ok(first.steps.every((step) => step.id.startsWith('saved-digest:/')));
});

test('details separate referenced saved configuration and omit unused literal input fields', () => {
  const model = project([
    invoke('consumer', {
      literal: 'not a relationship',
      selected: '${{ config.count }}',
    }),
    {
      id: 'loop',
      type: 'loop',
      maxIterations: '${{ config.count }}',
      steps: [],
      output: {},
    },
  ]);
  const consumer = model.data.nodes.find(
    (entry) => entry.stepId === model.steps[0]!.id,
  )!;
  assert.ok(!consumer.ports.some((port) => port.path.includes('literal')));
  for (const step of model.steps) {
    const detail = model.details.find((entry) => entry.id === step.detailId)!;
    assert.deepEqual(detail.configuration, {
      configFields: [
        { path: ['count'], available: true, savedValue: 3, dynamic: false },
      ],
    });
  }
  assert.ok(
    model.data.nodes
      .find((entry) => entry.stepId === model.steps[1]!.id)!
      .ports.some(
        (port) => port.role === 'output' && port.path.join('.') === 'output',
      ),
  );
});

test('foreach item contexts stay scoped and literal collection access uses the collection endpoint', () => {
  const model = project([
    ...['first', 'second'].map((id) => ({
      id,
      type: 'foreach',
      foreach: '${{ input.rows }}',
      as: 'row',
      key: '${{ row.id }}',
      steps: [invoke('same', '${{ row.value }}')],
      output: '${{ steps.same.output }}',
    })),
    invoke('read', '${{ steps.first.output[0].score }}'),
  ]);
  assert.equal(model.availability.overall, 'complete');
  const items = model.data.nodes.filter((entry) => entry.kind === 'item');
  assert.equal(items.length, 2);
  assert.notEqual(items[0]!.scopeId, items[1]!.scopeId);
  const reader = model.steps.find((step) => step.localId === 'read')!;
  const edge = model.data.edges.find(
    (entry) => entry.target.nodeId === reader.id,
  )!;
  const producer = model.data.nodes.find(
    (entry) => entry.id === edge.source.nodeId,
  )!;
  assert.deepEqual(
    producer.ports.find((entry) => entry.id === edge.source.portId)!.path,
    ['output'],
  );
  assert.equal(edge.dynamic, false);
  assert.equal(edge.label, 'collection access: 0.score');
});

test('saved Recipe input contributes declared dependencies without pruning Policy defaults', () => {
  const model = projectPolicyStructure({
    experimentId: 'recipe-input',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'input-fixture',
      steps: [],
      input: { candidate: '${{ application.defaultCandidate }}' },
      output: '${{ input.candidate }}',
    },
    recipe: {
      policy: {
        config: { useSaved: true },
        input: {
          candidate:
            '${{ if(config.useSaved, application.savedCandidate, application.otherCandidate) }}',
        },
      },
    },
  });
  assert.equal(model.availability.overall, 'complete');
  const input = node(model, 'input');
  const application = node(model, 'application');
  assert.deepEqual(
    application.ports.map((port) => port.path),
    [['defaultCandidate'], ['savedCandidate'], ['otherCandidate']],
  );
  const incoming = model.data.edges.filter(
    (edge) => edge.target.nodeId === input.id,
  );
  assert.equal(
    incoming.filter((edge) => edge.label === 'input default').length,
    1,
  );
  assert.equal(
    incoming.filter((edge) => edge.label === 'Recipe input').length,
    3,
  );
  assert.ok(
    incoming
      .filter((edge) => edge.label === 'Recipe input')
      .every((edge) => edge.location === '/recipe/policy/input/candidate'),
  );
  assert.ok(!model.flow.nodes.some((entry) => entry.kind === 'failure'));
});

test('missing saved binding fields and Reflection configuration mark details partial', () => {
  const model = projectPolicyStructure({
    experimentId: 'missing-context',
    definitionDigest: 'saved',
    reflection: null,
    policy: {
      schemaVersion: 'rsi.policy/v1',
      id: 'missing-context',
      require: { worker: { contract: 'contract.fixture' } },
      steps: [
        { id: 'call', type: 'invoke', use: 'worker' },
        { id: 'reflect', type: 'reflection' },
      ],
      output: null,
    },
    recipe: {
      policy: { config: {}, input: {} },
      bindings: { worker: { config: {} } },
    },
  });
  assert.deepEqual(model.availability, {
    overall: 'partial',
    flow: 'complete',
    data: 'complete',
    details: 'partial',
  });
  assert.equal(model.diagnostics.length, 2);
  assert.ok(
    model.diagnostics.every(
      (diagnostic) =>
        diagnostic.category === 'missing-source' &&
        diagnostic.view === 'details' &&
        diagnostic.nodeId,
    ),
  );
});
