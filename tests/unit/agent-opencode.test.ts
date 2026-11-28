import test, { type TestContext } from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { agentFixture, answerSchema } from '../fixtures/agent-execution.js';
import { object, strings } from '../../src/shared/json.js';
import { readAgentRecords } from '../../src/runtime/storage/agent-records.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';

function mockHostConfig(t: TestContext, variables: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

test('OpenCode records its V2 parts and returns only the stopped final message', async (t) => {
  const nativeConfig = String.raw`{
    // Provider and instruction settings may come from native JSONC.
    "instructions": {env:ARSI_REVIEW_RULES},
    "provider": {"custom": {
      "options": {"baseURL": "https://example.test/v1",},
      "name": "Keep \"quoted\" text and /* literal */",
    },},
  }`;
  const nativeRules = '["./review-instructions.md"]';
  const localConfig = '{"instructions":["./local-instructions.md"]}';
  mockHostConfig(t, {
    OPENCODE_CONFIG_CONTENT: nativeConfig,
    ARSI_REVIEW_RULES: nativeRules,
    OPENCODE_DISABLE_PROJECT_CONFIG: undefined,
  });
  const projects: string[] = [];
  const schemas: string[] = [];
  const nextSchema = { ...answerSchema, description: 'Second call schema' };
  const f = await agentFixture(async (spec, consume, context) => {
    const subsequent = projects.length > 0;
    assert.equal(spec.input, subsequent ? 'A second task' : f.request.message);
    assert(context.agentProject);
    projects.push(context.agentProject);
    await writeFile(join(context.agentProject, 'scratch.json'), '{}', {
      flag: 'wx',
    });
    assert.equal(spec.env?.PWD, context.agentProject);
    assert.equal(spec.env?.OPENCODE_CONFIG_CONTENT, nativeConfig);
    assert.equal(spec.env?.ARSI_REVIEW_RULES, nativeRules);
    assert.equal(
      await readFile(join(context.agentProject, 'opencode.json'), 'utf8'),
      localConfig,
    );
    assert.equal(
      await readFile(
        join(context.agentProject, 'local-instructions.md'),
        'utf8',
      ),
      'Local instructions',
    );
    const projectConfig = object(
      JSON.parse(
        (
          await readFile(join(projects[0]!, 'opencode.jsonc'), 'utf8')
        ).replaceAll(
          '{env:ARSI_OPENCODE_TASK_INSTRUCTIONS}',
          () => spec.env!.ARSI_OPENCODE_TASK_INSTRUCTIONS!,
        ),
      ),
    );
    const instructionPaths = strings(projectConfig.instructions);
    assert.equal(instructionPaths.length, 2);
    assert.equal(
      resolve(instructionPaths[0]!),
      join(projects[0]!, 'AGENTS.md'),
    );
    assert.match(
      await readFile(instructionPaths[0]!, 'utf8'),
      /Read context and edit candidate only when authorized\./,
    );
    const schemaPath = instructionPaths[1]!;
    schemas.push(schemaPath);
    const instructions = await readFile(schemaPath, 'utf8');
    assert.deepEqual(
      JSON.parse(instructions.split('\n\n').at(-1)!),
      subsequent ? nextSchema : f.request.outputSchema,
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
  const cwd = await prepareAgentProject(
    f.owner,
    'Read context and edit candidate only when authorized.',
    {
      'candidate/input.txt': 'original',
      'opencode.json': localConfig,
      'local-instructions.md': 'Local instructions',
    },
    [],
    [],
  );
  const agent = await createAgentOpenCode(
    {
      executable: process.execPath,
      options: ['--model', 'provider/model#high'],
    },
    f.context,
  );
  assert.deepEqual(await f.execute(agent, { ...f.request, cwd }), {
    answer: 'ok',
  });
  await assert.rejects(access(join(cwd, 'opencode.jsonc')), {
    code: 'ENOENT',
  });
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, nativeConfig);
  assert.equal(
    await readFile(join(cwd, 'AGENTS.md'), 'utf8'),
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
  assert.deepEqual(
    await f.execute(agent, {
      ...f.request,
      cwd,
      message: 'A second task',
      outputSchema: nextSchema,
    }),
    { answer: 'ok' },
  );
  assert.equal(projects.length, 2);
  assert.notEqual(projects[0], projects[1]);
  for (const project of projects)
    assert.equal(await readFile(join(project, 'scratch.json'), 'utf8'), '{}');
  for (const schema of schemas)
    await assert.rejects(access(schema), { code: 'ENOENT' });
});

test('OpenCode supplies its schema through native global config when needed', async (t) => {
  for (const { hasNativeConfig, session } of [
    { hasNativeConfig: false, session: false },
    { hasNativeConfig: true, session: false },
    { hasNativeConfig: true, session: true },
  ]) {
    await t.test(
      session
        ? 'resume a native session from an earlier project'
        : `project config disabled with ${hasNativeConfig ? 'external and inline config' : 'inline config only'}`,
      async (t) => {
        const nativeConfig = hasNativeConfig
          ? '{ // Keep the external and inline configuration.\n "instructions": ["./custom.md",],\n}'
          : '{"instructions": {env:ARSI_REVIEW_RULES}}';
        const externalPath = hasNativeConfig
          ? '/path/to/custom-opencode.json'
          : undefined;
        mockHostConfig(t, {
          OPENCODE_CONFIG: externalPath,
          OPENCODE_CONFIG_CONTENT: nativeConfig,
          OPENCODE_DISABLE_PROJECT_CONFIG: session ? undefined : 'TRUE',
        });

        let instructionPath = '';
        const f = await agentFixture(async (spec, consume, context) => {
          assert.equal(context.agentProject, f.directory);
          if (session)
            assert.deepEqual(spec.args.slice(-2), ['--session', 's1']);
          else assert.equal(spec.env?.OPENCODE_DISABLE_PROJECT_CONFIG, 'TRUE');
          assert.equal(spec.input, f.request.message);
          const env = spec.env!;
          const configuration = hasNativeConfig
            ? env.OPENCODE_CONFIG_CONTENT!
            : await readFile(env.OPENCODE_CONFIG!, 'utf8');
          const instructions = strings(
            object(JSON.parse(configuration)).instructions,
          );
          if (hasNativeConfig) {
            assert.equal(env.OPENCODE_CONFIG, externalPath);
            assert.equal(instructions[0], './custom.md');
          } else {
            assert.equal(env.OPENCODE_CONFIG_CONTENT, nativeConfig);
          }
          assert.equal(instructions.at(-2), join(f.directory, 'AGENTS.md'));
          instructionPath = instructions.at(-1)!;
          const schema = (await readFile(instructionPath, 'utf8'))
            .split('\n\n')
            .at(-1)!;
          assert.deepEqual(JSON.parse(schema), f.request.outputSchema);
          for (const event of [
            {
              type: 'text',
              sessionID: 's1',
              part: { messageID: 'm1', text: '{"answer":"ok"}' },
            },
            {
              type: 'step_finish',
              sessionID: 's1',
              part: { messageID: 'm1', reason: 'stop' },
            },
          ])
            await consume(JSON.stringify(event), () => {});
        });
        t.after(() => f.close());
        const agent = await createAgentOpenCode(
          {
            executable: process.execPath,
            options: session ? ['--session', 's1'] : [],
          },
          f.context,
        );
        assert.deepEqual(await f.execute(agent), { answer: 'ok' });
        await assert.rejects(access(instructionPath), { code: 'ENOENT' });
      },
    );
  }
});
