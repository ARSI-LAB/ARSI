import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { FileFacts } from '../../src/runtime/storage/index.js';
import { PolicyCheckpoints } from '../../src/runtime/policy/checkpoint.js';

const definition = {
  schemaVersion: 'rsi.policy/v1',
  id: 'policy.checkpoint',
  input_schema: { type: 'object' },
  output_schema: true,
  steps: [],
  output: null,
};
function options() {
  return {
    application: {},
    context: new RuntimeContext().extend({
      signal: new AbortController().signal,
    }),
    invoke: async (): Promise<JsonValue> => null,
  };
}
async function factsFor(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-checkpoints-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new FileFacts(directory);
}

test('incremental checkpoints persist bounded records across concurrent branches and resume without calls', async (t) => {
  const facts = await factsFor(t);
  const writes: JsonObject[] = [];
  const write = facts.write.bind(facts);
  facts.write = async (kind, id, value) => {
    writes.push(structuredClone(value));
    await write(kind, id, value);
  };
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = new Policy(
    {
      ...definition,
      require: { work: { contract: contract.id } },
      steps: [
        {
          id: 'each',
          type: 'foreach',
          foreach: Array.from({ length: 80 }, (_, i) => i),
          as: 'item',
          key: '${{ item }}',
          concurrency: 5,
          steps: [
            { id: 'call', type: 'invoke', use: 'work', with: '${{ item }}' },
          ],
          output: '${{ steps.call.output }}',
        },
      ],
      output: '${{ steps.each.output }}',
    },
    { contracts: { contract: () => contract } },
  );
  let calls = 0;
  const invoke = async (_binding: string, value: JsonValue) => {
    calls++;
    return value;
  };
  const checkpoints = new PolicyCheckpoints(facts, 'test');
  const result = await policy.execute({
    ...options(),
    invoke,
    incrementalCheckpoint: checkpoints,
  });
  assert.deepEqual(
    result,
    Array.from({ length: 80 }, (_, i) => i),
  );
  assert.equal(calls, 80);
  assert.equal(writes.length, 164);
  assert.ok(
    writes.reduce((sum, item) => sum + JSON.stringify(item).length, 0) < 65000,
  );
  assert.ok(writes.every((item) => !Object.hasOwn(item, 'journal')));
  const resumed = new PolicyCheckpoints(facts, 'test');
  assert.deepEqual(
    await policy.execute({
      ...options(),
      invoke,
      restore: await resumed.restore(),
      incrementalCheckpoint: resumed,
    }),
    result,
  );
  assert.equal(calls, 80);
  assert.equal(writes.length, 164);
});

test('entry and head write failures expose only the committed prefix and can resume', async (t) => {
  for (const failure of ['entry', 'head']) {
    const facts = await factsFor(t);
    const policy = new Policy({
      ...definition,
      steps: [
        { id: 'one', type: 'if', if: true, then: { steps: [] } },
        { id: 'two', type: 'if', if: true, then: { steps: [] } },
      ],
    });
    const write = facts.write.bind(facts);
    let entryWrites = 0;
    let headWrites = 0;
    facts.write = async (kind, id, value) => {
      if (
        kind === 'checkpoint-entries' &&
        ++entryWrites === 2 &&
        failure === 'entry'
      )
        throw new Error('entry failed');
      if (kind === 'checkpoints' && ++headWrites === 2 && failure === 'head')
        throw new Error('head failed');
      await write(kind, id, value);
    };
    await assert.rejects(
      policy.execute({
        ...options(),
        incrementalCheckpoint: new PolicyCheckpoints(facts, 'test'),
      }),
      /failed/,
    );
    const resumed = new PolicyCheckpoints(facts, 'test');
    const restore = await resumed.restore();
    assert.deepEqual(Object.keys(restore!.journal as JsonObject), [
      'steps/one',
    ]);
    assert.deepEqual(restore!.boundaries, {});
    facts.write = write;
    assert.equal(
      await policy.execute({
        ...options(),
        restore,
        incrementalCheckpoint: resumed,
      }),
      null,
    );
    const complete = await new PolicyCheckpoints(facts, 'test').restore();
    assert.deepEqual(Object.keys(complete!.journal as JsonObject), [
      'steps/one',
      'steps/two',
    ]);
    assert.deepEqual(complete!.boundaries, { 'policy-completed': true });
  }
});

test('v1 snapshots resume through incremental persistence without reexecuting committed steps', async (t) => {
  const facts = await factsFor(t);
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = new Policy(
    {
      ...definition,
      require: { work: { contract: contract.id } },
      steps: [
        { id: 'one', type: 'invoke', use: 'work' },
        { id: 'two', type: 'invoke', use: 'work' },
      ],
    },
    { contracts: { contract: () => contract } },
  );
  let snapshot: JsonObject | undefined;
  let calls = 0;
  const invoke = async () => {
    calls++;
    return calls;
  };
  await assert.rejects(
    policy.execute({
      ...options(),
      invoke,
      checkpoint: async (value) => {
        snapshot = value;
        throw new Error('interrupt');
      },
    }),
    /interrupt/,
  );
  await facts.write('checkpoints', 'test', snapshot!);
  const adapter = new PolicyCheckpoints(facts, 'test');
  assert.equal(
    await policy.execute({
      ...options(),
      invoke,
      restore: await adapter.restore(),
      incrementalCheckpoint: adapter,
    }),
    null,
  );
  assert.equal(calls, 2);
  const next = new PolicyCheckpoints(facts, 'test');
  await policy.execute({
    ...options(),
    invoke,
    restore: await next.restore(),
    incrementalCheckpoint: next,
  });
  assert.equal(calls, 2);
});

test('Policy facade preserves declaration serialization and digest', () => {
  const policy = new Policy(definition);
  assert.equal(
    policy.digest,
    'cedbe3673a1b7b58fa8d84c4b9fd0d80665f1a3e93d36f5ef48fd88bdd083396',
  );
  assert.deepEqual(policy.toJSON(), {
    ...definition,
    config_schema: { type: 'object', additionalProperties: false },
    state_schema: { type: 'object', additionalProperties: false },
    input: {},
    state: {},
    require: {},
    defaults: {},
  });
});

test('an initial failed head leaves no committed state and corrupted committed entries reject recovery', async (t) => {
  const facts = await factsFor(t);
  const write = facts.write.bind(facts);
  facts.write = async (kind, id, value) => {
    if (kind === 'checkpoints') throw new Error('head failed');
    await write(kind, id, value);
  };
  const change = {
    identity: 'identity',
    kind: 'step' as const,
    path: 'steps/one',
    value: { result: { kind: 'completed', output: 1 }, patch: {} },
  };
  await assert.rejects(
    new PolicyCheckpoints(facts, 'test').append(change),
    /head failed/,
  );
  assert.equal(await new PolicyCheckpoints(facts, 'test').restore(), undefined);
  facts.write = write;
  await new PolicyCheckpoints(facts, 'test').append(change);
  const entry = await facts.read('checkpoint-entries', 'test.0');
  await write('checkpoint-entries', 'test.0', { ...entry, path: '__proto__' });
  await assert.rejects(
    new PolicyCheckpoints(facts, 'test').restore(),
    /invalid step path/,
  );
  await write('checkpoint-entries', 'test.0', { ...entry, sequence: 9 });
  await assert.rejects(
    new PolicyCheckpoints(facts, 'test').restore(),
    /sequence mismatch/,
  );
});

test('cancellation after an incremental commit preserves the step and stops subsequent work', async (t) => {
  const facts = await factsFor(t);
  const controller = new AbortController();
  const adapter = new PolicyCheckpoints(facts, 'test');
  const policy = new Policy({
    ...definition,
    steps: [
      { id: 'one', type: 'if', if: true, then: { steps: [] } },
      { id: 'two', type: 'if', if: true, then: { steps: [] } },
    ],
  });
  await assert.rejects(
    policy.execute({
      ...options(),
      context: new RuntimeContext().extend({ signal: controller.signal }),
      incrementalCheckpoint: {
        append: async (change) => {
          await adapter.append(change);
          controller.abort(new Error('cancelled'));
        },
      },
    }),
    /cancelled/,
  );
  const restored = await new PolicyCheckpoints(facts, 'test').restore();
  assert.deepEqual(Object.keys(restored!.journal as JsonObject), ['steps/one']);
  assert.deepEqual(restored!.boundaries, {});
});

test('a head write with an unknown reported outcome recovers its committed step without repeating the call', async (t) => {
  const facts = await factsFor(t);
  const write = facts.write.bind(facts);
  let first = true;
  facts.write = async (kind, id, value) => {
    await write(kind, id, value);
    if (kind === 'checkpoints' && first) {
      first = false;
      throw new Error('unknown head outcome');
    }
  };
  const contract = {
    id: 'contract.work',
    input_schema: true,
    output_schema: true,
  };
  const policy = new Policy(
    {
      ...definition,
      require: { work: { contract: contract.id } },
      steps: [{ id: 'one', type: 'invoke', use: 'work' }],
    },
    { contracts: { contract: () => contract } },
  );
  let calls = 0;
  const invoke = async () => {
    calls++;
    return calls;
  };
  await assert.rejects(
    policy.execute({
      ...options(),
      invoke,
      incrementalCheckpoint: new PolicyCheckpoints(facts, 'test'),
    }),
    /unknown head outcome/,
  );
  const adapter = new PolicyCheckpoints(facts, 'test');
  const restore = await adapter.restore();
  assert.deepEqual(Object.keys(restore!.journal as JsonObject), ['steps/one']);
  await policy.execute({
    ...options(),
    invoke,
    restore,
    incrementalCheckpoint: adapter,
  });
  assert.equal(calls, 1);
});
