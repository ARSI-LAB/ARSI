import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readVirtualFile,
  readFileSchema,
} from '../../src/plugins/agent-codex/virtual-files.js';
import { validate } from '../../src/shared/schema.js';

test('virtual reads paginate a long UTF-8 JSON line without losing or duplicating bytes', () => {
  const content = '证据😀"\\\n'.repeat(2000).replaceAll('\n', '\\n');
  let byteOffset = 0;
  let restored = '';
  do {
    const output = readVirtualFile(
      { 'evidence.json': content },
      { path: 'evidence.json', byteOffset, maxBytes: 1024 },
    );
    assert.ok(Buffer.byteLength(output) <= 1024);
    const result = JSON.parse(output);
    assert.ok(!result.text.includes('\uFFFD'));
    restored += result.text;
    if (result.nextByteOffset === null) break;
    assert.ok(result.nextByteOffset > byteOffset);
    byteOffset = result.nextByteOffset;
  } while (true);
  assert.equal(restored, content);
});

test('virtual reads bound lines and reject unauthorized files and invalid pagination', () => {
  const files = { 'a.txt': 'one\ntwo\nthree' };
  const result = JSON.parse(
    readVirtualFile(files, { path: 'a.txt', startLine: 2, lineCount: 1 }),
  );
  assert.equal(result.text, 'two');
  assert.equal(result.moreLines, true);
  assert.equal(JSON.parse(readVirtualFile(files, { path: '.' })).text, 'a.txt');
  assert.throws(
    () => readVirtualFile(files, { path: '/etc/passwd' }),
    /outside authorized/,
  );
  assert.throws(
    () => readVirtualFile(files, { path: 'a.txt', byteOffset: 1000 }),
    /byte offset/,
  );
  for (const args of [
    { path: 'a.txt', lineCount: 501 },
    { path: 'a.txt', maxBytes: 32769 },
    { path: 'a.txt', byteOffset: -1 },
  ])
    assert.throws(() => validate(readFileSchema, args, 'read_file'));
});
