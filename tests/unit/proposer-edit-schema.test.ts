import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../src/contracts/index.js';
import { proposerEditOutputSchema } from '../../src/plugins/proposer-agent/edits.js';
import { object } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

test('proposer edit anyOf preserves the exclusive tagged operation contract', () => {
  const legacy = object(structuredClone(proposerEditOutputSchema));
  const items = object(object(object(legacy.properties).edits).items);
  assert.ok(Array.isArray(items.anyOf));
  const tags = items.anyOf.map((value) => {
    const branch = object(value);
    assert.ok(Array.isArray(branch.required));
    assert.ok(branch.required.includes('op'));
    const tag = object(object(branch.properties).op).const;
    assert.equal(typeof tag, 'string');
    return tag;
  });
  assert.equal(new Set(tags).size, tags.length);
  items.oneOf = items.anyOf;
  delete items.anyOf;

  const patch = {
    op: 'patch',
    path: 'skill.md',
    changes: [{ oldText: 'old', newText: 'new' }],
  };
  const create = { op: 'create', path: 'new.md', content: 'New guidance' };
  const remove = { op: 'delete', path: 'obsolete.md' };
  const cases: [boolean, JsonObject][] = [
    [true, patch],
    [true, create],
    [false, { ...create, op: 'replace' }],
    [false, { path: 'skill.md', content: 'Legacy edit' }],
    [false, { ...create, op: 'replace', content: null }],
    [true, remove],
    [false, { ...patch, content: 'Mixed patch/create fields' }],
    [false, { ...create, changes: patch.changes }],
    [false, { ...remove, content: null }],
    [false, { ...remove, op: 'unknown' }],
    [false, { ...create, content: null }],
    [false, { ...patch, changes: [] }],
    [true, { ...patch, changes: [{ oldText: '', newText: 'new' }] }],
    [false, { op: 'create', path: 'missing-content.md' }],
    [false, { op: 'delete' }],
  ];
  for (const schema of [proposerEditOutputSchema, legacy]) {
    validate(schema, { edits: [], reason: 'No change' }, 'patch output');
    for (const [accepted, edit] of cases) {
      const check = () =>
        validate(schema, { edits: [edit], reason: 'Proposal' }, 'patch output');
      if (accepted) assert.doesNotThrow(check);
      else assert.throws(check, /patch output/);
    }
  }
});
