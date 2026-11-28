import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentFixture,
  claudeAgentFixture,
} from '../fixtures/agent-execution.js';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import { claudeCodeDefinition } from '../../src/plugins/agent-claudecode/index.js';
import { dshDefinition } from '../../src/plugins/agent-dsh/index.js';
import { openCodeDefinition } from '../../src/plugins/agent-opencode/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import type { JsonObject } from '../../src/contracts/index.js';

for (const [name, create, events, pattern] of [
  [
    'Claude Code',
    createAgentClaudeCode,
    [{ type: 'result', is_error: true, subtype: 'error_during_execution' }],
    /task failed/,
  ],
  [
    'Claude Code',
    createAgentClaudeCode,
    [
      {
        type: 'result',
        is_error: false,
        subtype: 'success',
        permission_denials: [{}],
      },
    ],
    /requires permission/,
  ],
  [
    'Claude Code',
    createAgentClaudeCode,
    [{ type: 'result', is_error: false, subtype: 'success' }],
    /no structured output/,
  ],
  ['DSH', createAgentDsh, [], /no final result/],
  [
    'DSH',
    createAgentDsh,
    [
      { type: 'session', sessionId: 's' },
      {
        type: 'final',
        sessionId: 's',
        reason: { kind: 'aborted' },
        text: '{"answer":"ok"}',
      },
    ],
    /did not complete/,
  ],
  [
    'DSH',
    createAgentDsh,
    [
      { type: 'session', sessionId: 's' },
      {
        type: 'final',
        sessionId: 'other',
        reason: { kind: 'completed' },
        text: '{"answer":"ok"}',
      },
    ],
    /Invalid DSH final session/,
  ],
  [
    'DSH',
    createAgentDsh,
    [{ type: 'error', message: 'native error' }],
    /native error/,
  ],
  [
    'OpenCode',
    createAgentOpenCode,
    [{ type: 'text', part: { messageID: 'm', text: '{"answer":"ok"}' } }],
    /no successfully completed/,
  ],
  [
    'OpenCode',
    createAgentOpenCode,
    [{ type: 'step_finish', part: { messageID: 'm', reason: 'error' } }],
    /no successfully completed/,
  ],
  ['OpenCode', createAgentOpenCode, [{ type: 'error' }], /execution failed/],
] as const) {
  test(`${name} rejects native failure without another launch: ${pattern.source}`, async (t) => {
    let launches = 0;
    const fixture = name === 'Claude Code' ? claudeAgentFixture : agentFixture;
    const f = await fixture(async (_spec, consume) => {
      launches++;
      for (const event of events)
        await consume(JSON.stringify(event), () => {});
    });
    t.after(() => f.close());
    const agent = await create({ executable: process.execPath }, f.context);
    await assert.rejects(f.execute(agent), pattern);
    assert.equal(launches, 1);
    if (name === 'DSH')
      await assert.rejects(
        access(join(f.context.directory, 'dsh-launch.json')),
        {
          code: 'ENOENT',
        },
      );
  });
}

for (const [name, definition] of [
  ['Claude Code', claudeCodeDefinition],
  ['DSH', dshDefinition],
  ['OpenCode', openCodeDefinition],
] as const) {
  test(`${name} preserves launch failures and rejects invalid configuration`, async (t) => {
    const registry = new Registry();
    t.after(() => registry.dispose());
    registry.registerOperation(definition);
    const fixture = name === 'Claude Code' ? claudeAgentFixture : agentFixture;
    const f = await fixture(async () => {
      throw new Error('Native launch failed');
    });
    t.after(() => f.close());
    const invalidConfigs: JsonObject[] = [
      { executable: '' },
      { unsupported: true },
    ];
    for (const invalid of invalidConfigs)
      await assert.rejects(
        registry.get(definition.id).create(invalid, f.context),
        /config/,
      );
    const agent = await definition.create(
      { executable: process.execPath },
      f.context,
    );
    await assert.rejects(f.execute(agent), /Native launch failed/);
  });
}
