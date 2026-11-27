import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('DSH consumes committed text, thinking, tools, truncation and its native final result', async (t) => {
  let executionProject = '';
  const f = await agentFixture(async (spec, consume, context) => {
    assert.equal(spec.input, f.request.message);
    assert(context.agentProject);
    executionProject = context.agentProject;
    const instructions = await readFile(
      join(executionProject, 'AGENTS.md'),
      'utf8',
    );
    assert.deepEqual(
      JSON.parse(instructions.split('\n\n')[2]!),
      f.request.outputSchema,
    );
    assert(
      instructions.includes(
        'Read context and edit candidate only when authorized.',
      ),
    );
    assert.equal(
      await readFile(join(executionProject, 'candidate/input.txt'), 'utf8'),
      'original',
    );
    const patch: unknown = JSON.parse(
      await readFile(spec.args[spec.args.indexOf('--patch') + 1]!, 'utf8'),
    );
    assert(Array.isArray(patch));
    assert.equal(
      patch.find((row) => row.id === 'agent-instructions')?.disabled,
      false,
    );
    assert(!spec.args.includes('--permission-mode'));
    assert.deepEqual(spec.args.slice(-4), [
      '--json',
      '--session-id',
      'existing-session',
      '-',
    ]);
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
  assert.notEqual(executionProject, f.directory);
  assert.equal(
    await readFile(join(f.directory, 'AGENTS.md'), 'utf8'),
    'Read context and edit candidate only when authorized.\n',
  );
  const records = await readAgentRecords(f.context.directory, 0, 100, true);
  assert.deepEqual(records.submitted?.event, {
    type: 'task.submitted',
    text: f.request.message,
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

test('DSH reuses the prepared execution cwd for another message in the same session', async (t) => {
  const projects: string[] = [];
  const f = await agentFixture(async (_spec, consume, context) => {
    assert(context.agentProject);
    projects.push(context.agentProject);
    await consume('{"type":"session","sessionId":"s1"}', () => {});
    await consume(
      JSON.stringify({
        type: 'final',
        sessionId: 's1',
        reason: { kind: 'completed' },
        text: '{"answer":"ok"}',
      }),
      () => {},
    );
  });
  t.after(() => f.close());
  const agent = await createAgentDsh(
    { executable: process.execPath, options: ['--session-id', 's1'] },
    f.context,
  );
  await f.execute(agent);
  await f.execute(agent, { ...f.request, message: 'Continue the task.' });
  assert.equal(projects.length, 2);
  assert.equal(projects[0], projects[1]);
  await writeFile(join(projects[0]!, 'candidate/input.txt'), 'changed');
  await assert.rejects(
    f.execute(agent, { ...f.request, message: 'Continue again.' }),
    /Native Agent project changed/,
  );
  assert.equal(projects.length, 2);
});
