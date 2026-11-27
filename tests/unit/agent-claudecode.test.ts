import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentOutputError } from '../../src/contracts/runtime/errors.js';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('Claude translates text, thinking and correlated tool results while returning structured output', async (t) => {
  let submittedText: string | undefined;
  const f = await agentFixture(async (spec, consume) => {
    submittedText = spec.input;
    assert.equal(spec.input, f.request.message);
    const schemaOption = spec.args.indexOf('--json-schema');
    assert.notEqual(schemaOption, -1);
    assert.deepEqual(
      JSON.parse(spec.args[schemaOption + 1]!),
      f.request.outputSchema,
    );
    assert(spec.args.includes('stream-json'));
    assert(spec.args.includes('--forward-subagent-text'));
    assert.deepEqual(spec.args.slice(-6), [
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--append-system-prompt',
      'Check each file.',
    ]);
    for (const message of [
      { type: 'assistant', message: null },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'thinking', thinking: 'visible' },
            { type: 'text', text: 'Working' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { path: 'candidate/input.txt' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'original' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'delegate',
          content: [
            {
              type: 'tool_use',
              id: 'delegate-child',
              name: 'Agent',
              input: { prompt: 'Inspect the evidence' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'delegate-child',
        message: {
          id: 'child-answer',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Observed evidence' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'main-answer',
          content: [{ type: 'text', text: 'Task completed.' }],
        },
      },
      {
        type: 'result',
        is_error: false,
        subtype: 'success',
        result: 'Task completed.',
        structured_output: { answer: 'ok' },
        usage: { input_tokens: 10 },
      },
    ])
      await consume(JSON.stringify(message), () => {});
  });
  t.after(() => f.close());
  const agent = await createAgentClaudeCode(
    {
      executable: process.execPath,
      options: [
        '--model',
        'sonnet',
        '--effort',
        'low',
        '--append-system-prompt',
        'Check each file.',
      ],
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
    nativeStatus: 'success',
  });
  assert(
    records.items.some(
      (item) =>
        item.event?.type === 'observation.gap' &&
        item.event.reason.includes('object'),
    ),
  );
  assert(
    records.items.some(
      (r) => r.event?.type === 'tool.completed' && r.event.toolCallId === 't1',
    ),
  );
  assert(
    records.items.some(
      (r) =>
        r.event?.type === 'message.completed' && r.event.thinking === 'visible',
    ),
  );
  const delegation = records.items.find(
    ({ event }) => event.type === 'subagent.activity',
  );
  assert.equal(delegation?.runId, 'main');
  assert.deepEqual(delegation.event, {
    type: 'subagent.activity',
    activity: 'started',
    childRunId: 'delegate-child',
    text: 'Inspect the evidence',
  });
  const child = await readAgentRecords(
    f.context.directory,
    0,
    1,
    true,
    'delegate-child',
  );
  assert.equal(child.delegation?.message, 'Inspect the evidence');
  const finals = records.finalResponses.map(
    ({ sequence }) =>
      records.items.find((item) => item.sequence === sequence)?.event,
  );
  assert.deepEqual(
    finals.map((event) =>
      event?.type === 'message.completed' ? event.text : null,
    ),
    ['Observed evidence', 'Task completed.'],
  );
  assert.equal(finals[1]?.type, 'message.completed');
  assert.match(finals[1].messageId, /^main-answer:/);
});

for (const output of [undefined, null, [], 'text', { wrong: true }]) {
  test(`Claude classifies invalid output ${JSON.stringify(output)} without a second launch`, async (t) => {
    let launches = 0;
    const f = await agentFixture(async (_spec, consume) => {
      launches++;
      await consume(
        JSON.stringify({
          type: 'result',
          is_error: false,
          subtype: 'success',
          structured_output: output,
        }),
        () => {},
      );
    });
    t.after(() => f.close());
    const agent = await createAgentClaudeCode(
      { executable: process.execPath },
      f.context,
    );
    await assert.rejects(f.execute(agent), AgentOutputError);
    assert.equal(launches, 1);
    const records = await readAgentRecords(f.context.directory, 0, 100, true);
    assert.equal(records.recording, 'closed');
    assert.deepEqual(records.items.at(-1)?.event, {
      type: 'run.finished',
      status: 'completed',
      nativeStatus: 'success',
    });
  });
}
