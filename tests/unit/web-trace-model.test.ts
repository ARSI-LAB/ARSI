import test from 'node:test';
import assert from 'node:assert/strict';
import { traceRows } from '../../web/features/experiments/trace-model.js';
import type { CallTrace } from '../../src/contracts/observation.js';
function event(
  sequence: number,
  type: string,
  data: unknown,
  at: string | null = null,
): CallTrace['items'][number] {
  return {
    sequence,
    type,
    at,
    content: { text: JSON.stringify(data), truncated: false },
  };
}
test('trace pairs parallel tools by ID and retains model content and chronological steps', () => {
  const events = [
    event(0, 'message_end', {
      message: {
        content: [
          { type: 'thinking', thinking: 'Think' },
          { type: 'text', text: 'Answer' },
        ],
      },
    }),
    event(
      1,
      'tool_execution_start',
      { toolCallId: 'a', toolName: 'read', args: { path: 'a' } },
      '2026-11-03T00:00:00Z',
    ),
    event(2, 'tool_execution_start', {
      toolCallId: 'b',
      toolName: 'read',
      args: { path: 'b' },
    }),
    event(3, 'tool_execution_end', {
      toolCallId: 'b',
      toolName: 'read',
      result: 'bad',
      isError: true,
    }),
    event(
      4,
      'tool_execution_end',
      { toolCallId: 'a', toolName: 'read', result: 'ok' },
      '2026-11-03T00:00:02Z',
    ),
    event(5, 'message_end', {
      message: { content: [{ type: 'toolCall', name: 'read' }] },
    }),
    event(6, 'tool_execution_start', {
      toolCallId: 'c',
      toolName: 'read',
      args: { path: 'c' },
    }),
  ];
  const rows = traceRows(events);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].thinking, 'Think');
  assert.equal(rows[0].body, 'Answer');
  assert.equal(rows[1].result, 'ok');
  assert.equal(rows[1].duration, 2);
  assert.equal(rows[2].result, 'bad');
  assert.equal(rows[2].status, 'Failed');
  assert.equal(rows[3].step, 2);
  assert.equal(rows[3].status, 'Result not loaded');
  assert.equal(traceRows(events.slice(0, 3))[1].status, 'Result not loaded');
});
test('trace preserves unmatched results, invalid previews and missing timing without invention', () => {
  const rows = traceRows([
    event(0, 'tool_execution_start', { toolName: 'read' }),
    event(1, 'tool_execution_end', { toolName: 'read', result: 'ok' }),
    {
      sequence: 2,
      type: 'message_end',
      at: null,
      content: { text: '{"message":', truncated: true },
    },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].args, undefined);
  assert.equal(rows[1].duration, null);
  assert.equal(rows[2].status, 'Unavailable');
  assert.equal(rows[2].truncated, true);
});
