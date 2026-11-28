import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentOutputError } from '../../src/contracts/runtime/errors.js';

import { parseAgentResult } from '../../src/plugins/shared/native-agent/result.js';

test('parses complete agent JSON objects', () => {
  assert.deepEqual(parseAgentResult('{"value":1}'), { value: 1 });
});

test('extracts JSON from prose before the object', () => {
  assert.deepEqual(parseAgentResult('Here is the result: {"value":1}'), {
    value: 1,
  });
});

test('extracts JSON from prose after the object', () => {
  assert.deepEqual(
    parseAgentResult('```json\n{"value":{"items":[1,2]}}\n```\nDone.'),
    { value: { items: [1, 2] } },
  );
});

test('extracts JSON from prose both before and after the object', () => {
  assert.deepEqual(
    parseAgentResult('Result below:\n```json\n{"value":1}\n```\nEnd.'),
    { value: 1 },
  );
});

test('prefers the final fenced proposal over an inline parameter example', () => {
  assert.deepEqual(
    parseAgentResult(
      'I inspected {"max_num_seqs":64,"tuning.json":true} before answering.\n' +
        '```json\n{"proposals":[{"reason":"candidate","edits":[]}]}\n```',
    ),
    { proposals: [{ reason: 'candidate', edits: [] }] },
  );
});

test('prefers a proposal batch over an earlier complete result', () => {
  assert.deepEqual(
    parseAgentResult(
      'Earlier result: {"status":"draft"}\n' +
        'Final result: {"proposals":[{"reason":"candidate","edits":[]}]}',
    ),
    { proposals: [{ reason: 'candidate', edits: [] }] },
  );
});

test('prefers the final fenced edit over an earlier inline proposal example', () => {
  assert.deepEqual(
    parseAgentResult(
      'Example: {"proposals":[{"reason":"old","edits":[]}]}\n' +
        'Final:\n```json\n{"edits":[],"reason":"final"}\n```',
    ),
    { edits: [], reason: 'final' },
  );
});

test('rejects EOF-truncated output instead of persisting partial content', () => {
  assert.throws(
    () =>
      parseAgentResult(
        '{"edits":[{"path":"a.md","content":"half of the intended file',
      ),
    AgentOutputError,
  );
  assert.throws(
    () => parseAgentResult('{"edits":[],"reason":"complete string"'),
    AgentOutputError,
  );
});

test('does not repair malformed JSON that is not a simple EOF truncation', () => {
  assert.throws(() => parseAgentResult('{"a":1 "b":2}'), AgentOutputError);
});

test('does not extract a nested object from malformed complete JSON', () => {
  assert.throws(
    () => parseAgentResult('{"broken":1 "nested":{"value":2}}'),
    AgentOutputError,
  );
});
