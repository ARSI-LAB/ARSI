import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCodex } from '../../src/plugins/agent-codex/service.js';
import { createAgentClaudeCode } from '../../src/plugins/agent-claudecode/service.js';
import { createAgentDsh } from '../../src/plugins/agent-dsh/service.js';
import { createAgentOpenCode } from '../../src/plugins/agent-opencode/service.js';
import {
  agentFixture,
  claudeAgentFixture,
} from '../fixtures/agent-execution.js';

for (const [name, create] of [
  ['Codex', createAgentCodex],
  ['Claude Code', createAgentClaudeCode],
  ['DSH', createAgentDsh],
  ['OpenCode', createAgentOpenCode],
] as const) {
  test(`${name} retains config.timeoutMs and cancels its process scope`, async (t) => {
    const fixture = name === 'Claude Code' ? claudeAgentFixture : agentFixture;
    const f = await fixture(async (_spec, _consume, context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      context.signal.throwIfAborted();
    });
    t.after(() => f.close());
    const operation = await create(
      { executable: process.execPath, timeoutMs: 50 },
      f.context,
    );
    await assert.rejects(f.execute(operation), /Agent execution timed out/);
    assert.equal(f.context.signal.aborted, false);
  });
}
