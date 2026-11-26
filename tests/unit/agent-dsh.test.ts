import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('DSH consumes committed text, thinking, tools, truncation and its native final result', async (t) => {
  let submittedText: string | undefined;
  const f = await agentFixture(async (spec, consume) => {
    submittedText = spec.input;
    assert(!spec.args.includes('--permission-mode'));
    assert.deepEqual(spec.args.slice(-4), [
      '--json',
      '--session-id',
      'existing-session',
      '-',
    ]);
    const [body, reminder] = spec.input.split('\n\n');
    assert.deepEqual(JSON.parse(body), {
      goal: 'Return an answer',
      instruction:
        'Read AGENTS.md and follow the project instructions. Use native subagents for delegation, reading roles/<name>.md when a role is listed. The project is read-only; return proposed edits in the requested JSON rather than modifying files. Return only the JSON object matching outputSchema in your final answer.',
      outputSchema: f.request.outputSchema,
    });
    assert.equal(
      reminder,
      'After completing the task, your final response MUST be only the JSON object matching outputSchema above. Do not summarize your work in prose or Markdown. A prose response is a failed task.',
    );
    for (const event of [
      { type: 'session', sessionId: 's1' },
      { type: 'thinking', text: 'Visible reasoning' },
      { type: 'text', text: 'Working', truncated: true },
      {
        type: 'tool_call',
        callId: 't1',
        tool: 'Read',
        input: { path: 'candidate/input.txt' },
      },
      {
        type: 'tool_result',
        callId: 't1',
        result: 'original',
        status: 'completed',
      },
      {
        type: 'final',
        sessionId: 's1',
        reason: { kind: 'completed' },
        text: '{"answer":"ok"}',
      },
    ])
      await consume(JSON.stringify(event), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentDsh(
    {
      executable: process.execPath,
      options: ['--session-id', 'existing-session'],
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
    nativeStatus: 'completed',
  });
  assert(records.items.some((r) => r.event?.type === 'observation.gap'));
  assert(records.items.some((r) => r.event?.type === 'tool.completed'));
  const final = records.items.find(
    (item) => item.sequence === records.finalResponses[0]?.sequence,
  )?.event;
  assert.equal(final?.type, 'message.completed');
  assert.equal(final.text, '{"answer":"ok"}');
});
