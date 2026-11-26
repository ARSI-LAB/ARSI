import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('OpenCode records its V2 parts and returns only the stopped final message', async (t) => {
  let submittedText: string | undefined;
  const f = await agentFixture(async (spec, consume) => {
    submittedText = spec.input;
    assert.deepEqual(spec.args.slice(-7), [
      'run',
      '--standalone',
      '--format',
      'json',
      '--archived',
      '--model',
      'provider/model#high',
    ]);
    for (const event of [
      {
        type: 'tool_use',
        sessionID: 's1',
        part: {
          id: 'p1',
          tool: 'read',
          state: {
            status: 'completed',
            input: { path: 'candidate/input.txt' },
            output: 'original',
            time: { start: 1000, end: 3500 },
          },
        },
      },
      {
        type: 'text',
        sessionID: 's1',
        part: { id: 'text1', messageID: 'm1', text: '{"answer":' },
      },
      {
        type: 'text',
        sessionID: 'child',
        part: { id: 'child-text', messageID: 'm1', text: 'Child reply' },
      },
      {
        type: 'step_finish',
        sessionID: 'child',
        part: { id: 'child-finish', messageID: 'm1', reason: 'stop' },
      },
      {
        type: 'text',
        sessionID: 's1',
        part: { id: 'text2', messageID: 'm1', text: '"ok"}' },
      },
      {
        type: 'step_finish',
        sessionID: 's1',
        part: {
          id: 'finish1',
          messageID: 'm1',
          reason: 'stop',
          tokens: { input: 10, output: 5 },
        },
      },
    ])
      await consume(JSON.stringify(event), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentOpenCode(
    {
      executable: process.execPath,
      options: ['--model', 'provider/model#high'],
    },
    f.context,
  );
  assert.deepEqual(await f.execute(agent), { answer: 'ok' });
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.deepEqual(records.submitted?.event, {
    type: 'task.submitted',
    text: submittedText,
    outputSchema: f.request.outputSchema,
  });
  assert.deepEqual(records.items.at(-1)?.event, {
    type: 'run.finished',
    status: 'completed',
    nativeStatus: 'stop',
  });
  const final = records.items.find(
    (item) =>
      item.sequence ===
      records.finalResponses.find(({ runId }) => runId === 'main')?.sequence,
  );
  assert.deepEqual(final?.event, {
    type: 'message.completed',
    messageId: 'm1',
    role: 'assistant',
    text: '{"answer":"ok"}',
    phase: 'final_answer',
  });
  const childFinal = records.items.find(
    (item) =>
      item.sequence ===
      records.finalResponses.find(({ runId }) => runId === 'child')?.sequence,
  )?.event;
  assert.equal(childFinal?.type, 'message.completed');
  assert.equal(childFinal.text, 'Child reply');
  assert(
    records.items.some(
      (r) =>
        r.event.type === 'tool.completed' &&
        r.event.toolCallId === 'p1' &&
        r.event.durationMs === 2500,
    ),
  );
});
