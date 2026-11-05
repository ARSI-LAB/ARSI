import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEdits } from '../../src/plugins/proposer-agent/merge-edits.js';

test('single edits retain their content, order and rationale', () => {
  assert.deepEqual(
    mergeEdits(
      {
        edits: [
          { path: 'empty.txt', content: '' },
          { path: 'removed.txt', content: null },
          { path: 'unchanged.txt', content: 'original' },
        ],
        reason: 'Keep the proposed order.',
      },
      { 'removed.txt': 'old', 'unchanged.txt': 'original' },
    ),
    {
      edits: [
        { path: 'empty.txt', content: '' },
        { path: 'removed.txt', content: null },
        { path: 'unchanged.txt', content: 'original' },
      ],
      reason: 'Keep the proposed order.',
    },
  );
});

test('identical duplicate replacements and deletions collapse to one edit', () => {
  assert.deepEqual(
    mergeEdits(
      {
        edits: [
          { path: 'skill.md', content: 'replacement\n' },
          { path: 'removed.txt', content: null },
          { path: 'skill.md', content: 'replacement\n' },
          { path: 'removed.txt', content: null },
        ],
        reason: 'Combine proposals.',
      },
      { 'skill.md': 'original\n', 'removed.txt': 'old' },
    ),
    {
      edits: [
        { path: 'skill.md', content: 'replacement\n' },
        { path: 'removed.txt', content: null },
      ],
      reason: 'Combine proposals.',
    },
  );
});

test('baseline-equal variants do not conflict with a change or deletion', () => {
  assert.deepEqual(
    mergeEdits(
      {
        edits: [
          { path: 'skill.md', content: 'original' },
          { path: 'skill.md', content: 'changed' },
          { path: 'removed.txt', content: 'old' },
          { path: 'removed.txt', content: null },
          { path: 'absent.txt', content: null },
          { path: 'absent.txt', content: 'new' },
        ],
        reason: 'Use actual changes.',
      },
      { 'skill.md': 'original', 'removed.txt': 'old' },
    ).edits,
    [
      { path: 'skill.md', content: 'changed' },
      { path: 'removed.txt', content: null },
      { path: 'absent.txt', content: 'new' },
    ],
  );
});

test('independent line changes merge against the original parent', () => {
  const result = mergeEdits(
    {
      edits: [
        { path: 'skill.md', content: 'ALPHA\nbeta\ngamma\n' },
        { path: 'skill.md', content: 'alpha\nbeta\nGAMMA\n' },
      ],
      reason: 'Both improvements.',
    },
    { 'skill.md': 'alpha\nbeta\ngamma\n' },
  );
  assert.deepEqual(result, {
    edits: [{ path: 'skill.md', content: 'ALPHA\nbeta\nGAMMA\n' }],
    reason: 'Both improvements.',
  });
});

test('three variants merge shared changes only once and preserve every independent change', () => {
  const variants = [
    'A\nseparator\nB\nseparator\nc\nseparator\nd\n',
    'A\nseparator\nb\nseparator\nC\nseparator\nd\n',
    'a\nseparator\nB\nseparator\nc\nseparator\nD\n',
  ];
  for (const contents of [variants, [...variants].reverse()]) {
    assert.deepEqual(
      mergeEdits(
        {
          edits: contents.map((content) => ({ path: 'skill.md', content })),
          reason: 'Shared and independent improvements.',
        },
        { 'skill.md': 'a\nseparator\nb\nseparator\nc\nseparator\nd\n' },
      ).edits,
      [
        {
          path: 'skill.md',
          content: 'A\nseparator\nB\nseparator\nC\nseparator\nD\n',
        },
      ],
    );
  }
});

test('contradictory subsets among three variants cannot be hidden by an accumulated merge', () => {
  const variants = [
    'A\nseparator\nB\nseparator\nc\n',
    'A\nseparator\nb\nseparator\nC\n',
    'different\nseparator\nB\nseparator\nC\n',
  ];
  for (const contents of [variants, [...variants].reverse()]) {
    const result = mergeEdits(
      {
        edits: contents.map((content) => ({ path: 'skill.md', content })),
        reason: 'Conflicting proposals.',
      },
      { 'skill.md': 'a\nseparator\nb\nseparator\nc\n' },
    );
    assert.deepEqual(result.edits, []);
    assert.match(String(result.reason), /skill\.md/);
  }
});

test('overlapping replacements retain the whole parent and explain every conflicting path', () => {
  const result = mergeEdits(
    {
      edits: [
        { path: 'safe.txt', content: 'safe change' },
        { path: 'skill.md', content: 'first\n' },
        { path: 'skill.md', content: 'second\n' },
        { path: 'another.txt', content: 'one' },
        { path: 'another.txt', content: 'two' },
      ],
      reason: 'Original proposal rationale.',
    },
    { 'safe.txt': 'old', 'skill.md': 'base\n', 'another.txt': 'base' },
  );
  assert.deepEqual(result.edits, []);
  assert.match(String(result.reason), /skill\.md/);
  assert.match(String(result.reason), /another\.txt/);
  assert.match(String(result.reason), /parent/i);
  assert.match(String(result.reason), /Original proposal rationale\./);
  assert.doesNotMatch(JSON.stringify(result), /<<<<<<<|=======|>>>>>>>/);
});

for (const [name, parent, contents] of [
  ['delete versus modify', { 'skill.md': 'old' }, [null, 'new']],
  ['different additions to a new file', {}, ['one', 'two']],
  [
    'different insertions at the same line',
    { 'skill.md': 'a\nb\n' },
    ['a\nfirst\nb\n', 'a\nsecond\nb\n'],
  ],
] as const) {
  test(`${name} produces a no-change proposal`, () => {
    const result = mergeEdits(
      {
        edits: contents.map((content) => ({ path: 'skill.md', content })),
        reason: 'Combine.',
      },
      parent,
    );
    assert.deepEqual(result.edits, []);
    assert.match(String(result.reason), /skill\.md/);
  });
}

test('line merging preserves CRLF, spaces, tabs and a missing final newline', () => {
  assert.deepEqual(
    mergeEdits(
      {
        edits: [
          { path: 'skill.md', content: 'ALPHA\r\n \tkeep  \r\ngamma' },
          { path: 'skill.md', content: 'alpha\r\n \tkeep  \r\nGAMMA' },
        ],
        reason: 'Preserve bytes.',
      },
      { 'skill.md': 'alpha\r\n \tkeep  \r\ngamma' },
    ).edits,
    [{ path: 'skill.md', content: 'ALPHA\r\n \tkeep  \r\nGAMMA' }],
  );
});

test('merging accepts contents above the old implicit byte limit', () => {
  const large = '\u754c'.repeat(50000);
  const result = mergeEdits(
    {
      edits: [
        { path: 'large.txt', content: `${large}\nkeep\nbefore` },
        { path: 'large.txt', content: 'small\nkeep\nafter' },
      ],
      reason: 'Combine.',
    },
    { 'large.txt': 'small\nkeep\nbefore' },
  );
  assert.deepEqual(result.edits, [
    { path: 'large.txt', content: `${large}\nkeep\nafter` },
  ]);
});

test('invalid paths throw even when another path already conflicts', () => {
  assert.throws(
    () =>
      mergeEdits(
        {
          edits: [
            { path: 'conflict.txt', content: 'first' },
            { path: 'conflict.txt', content: 'second' },
            { path: '../outside.txt', content: 'invalid' },
          ],
          reason: 'Invalid path.',
        },
        { 'conflict.txt': 'original' },
      ),
    /path/i,
  );
});

test('overlapping edits still conflict on a large parent', () => {
  const result = mergeEdits(
    {
      edits: [
        { path: 'skill.md', content: 'first' },
        { path: 'skill.md', content: 'second' },
        { path: 'safe.txt', content: 'safe change' },
      ],
      reason: 'Original rationale.',
    },
    { 'skill.md': 'x'.repeat(131073), 'safe.txt': 'old' },
  );
  assert.deepEqual(result.edits, []);
  assert.match(String(result.reason), /overlapping changes/i);
  assert.match(String(result.reason), /skill\.md/);
  assert.match(String(result.reason), /Original rationale\./);
});

test('independent edits can merge into content above the old byte limit', () => {
  const base = `${'a'.repeat(60000)}\nkeep\nlast\n`;
  const prefix = `${'b'.repeat(40000)}\n`;
  const suffix = `${'c'.repeat(40000)}\n`;
  const result = mergeEdits(
    {
      edits: [
        { path: 'safe.txt', content: 'safe change' },
        { path: 'skill.md', content: `${prefix}${base}` },
        { path: 'skill.md', content: `${base}${suffix}` },
      ],
      reason: 'Independent large additions.',
    },
    { 'skill.md': base, 'safe.txt': 'original' },
  );
  assert.deepEqual(result.edits, [
    { path: 'safe.txt', content: 'safe change' },
    { path: 'skill.md', content: `${prefix}${base}${suffix}` },
  ]);
});

test('many short lines fall back before unbounded diff work', () => {
  const base = 'a\n'.repeat(10000);
  const result = mergeEdits(
    {
      edits: [
        { path: 'skill.md', content: `first\n${base}` },
        { path: 'skill.md', content: `${base}second\n` },
      ],
      reason: 'Large merge.',
    },
    { 'skill.md': base },
  );
  assert.deepEqual(result.edits, []);
  assert.match(String(result.reason), /limit|budget|bound/i);
});
