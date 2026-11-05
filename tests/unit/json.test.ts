import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeSnapshot } from '../../src/shared/json.js';

test('freezeSnapshot preserves scalar values', () => {
  for (const value of [null, undefined, false, 0, 'text'])
    assert.equal(freezeSnapshot(value), value);
});

test('freezeSnapshot freezes deep snapshots without overflowing the call stack', () => {
  let snapshot: object = { value: true };
  const nodes = [snapshot];
  for (let depth = 0; depth < 20000; depth++) {
    snapshot = { child: snapshot };
    nodes.push(snapshot);
  }
  assert.equal(freezeSnapshot(snapshot), snapshot);
  assert.ok(nodes.every((node) => Object.isFrozen(node)));
});

test('freezeSnapshot accepts shared children and traverses already frozen parents', () => {
  const child = { value: 1 };
  const items = [child];
  const snapshot = Object.freeze({ first: child, nested: { child }, items });
  assert.equal(freezeSnapshot(snapshot), snapshot);
  assert.equal(snapshot.first, snapshot.nested.child);
  assert.equal(snapshot.first, snapshot.items[0]);
  assert.ok(Object.isFrozen(snapshot.nested));
  assert.ok(Object.isFrozen(items));
  assert.throws(() => items.push({ value: 2 }), TypeError);
  assert.throws(() => (child.value = 2), TypeError);
  assert.equal(child.value, 1);
});

test('freezeSnapshot rejects self references and cycles through arrays', () => {
  const self: { self?: unknown } = {};
  self.self = self;
  Object.freeze(self);
  const items: unknown[] = [];
  const indirect = { items };
  items.push({ parent: indirect });
  for (const snapshot of [self, indirect])
    assert.throws(() => freezeSnapshot(snapshot), /cyclic snapshot/);
});
