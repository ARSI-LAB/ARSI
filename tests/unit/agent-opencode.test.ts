import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { agentFixture } from '../fixtures/agent-execution.js';
import { object, strings } from '../../src/shared/json.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';

test('OpenCode records its V2 parts and returns only the stopped final message', async (t) => {
  const previousConfig = process.env.OPENCODE_CONFIG_CONTENT;
  const nativeConfig = String.raw`{
    // Provider and instruction settings may come from native JSONC.
    "instructions": ["./custom.md",],
    "provider": {"custom": {
      "options": {"baseURL": "https://example.test/v1",},
      "name": "Keep \"quoted\" text and /* literal */",
    },},
  }`;
  process.env.OPENCODE_CONFIG_CONTENT = nativeConfig;
  t.after(() => {
    if (previousConfig === undefined)
      delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = previousConfig;
  });
  let instructionPath = '';
  const f = await agentFixture(async (spec, consume, context) => {
    assert.equal(spec.input, f.request.message);
    assert.equal(context.agentProject, f.directory);
    assert.equal(spec.env?.PWD, f.directory);
    const configText = spec.env?.OPENCODE_CONFIG_CONTENT;
    assert(configText);
    const launchConfig = object(JSON.parse(configText));
    assert.deepEqual(launchConfig.provider, {
      custom: {
        options: { baseURL: 'https://example.test/v1' },
        name: 'Keep "quoted" text and /* literal */',
      },
    });
    const instructionPaths = strings(launchConfig.instructions);
    assert.equal(instructionPaths.length, 3);
    assert.deepEqual(instructionPaths.slice(0, 2), [
      './custom.md',
      join(f.directory, 'AGENTS.md'),
    ]);
    instructionPath = instructionPaths[2]!;
    const instructions = await readFile(instructionPath, 'utf8');
    assert.deepEqual(
      JSON.parse(instructions.split('\n\n').at(-1)!),
      f.request.outputSchema,
    );
    assert.equal(
      await readFile(join(context.agentProject, 'candidate/input.txt'), 'utf8'),
      'original',
    );
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
  await assert.rejects(access(instructionPath), { code: 'ENOENT' });
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, nativeConfig);
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
