import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  agentConfigSchema,
  requestEdit,
} from '../../src/plugins/shared/agent-editing/index.js';
import { prepareAgentProject } from '../../src/index.js';
import { FileArtifacts, FileFacts } from '../../src/runtime/storage/index.js';
import { string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

test('editor rejects removed context configuration and preserves large instructions in its workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-editor-context-'));
  try {
    const prompt = join(root, 'prompt.md');
    const content = 'context '.repeat(20000);
    await writeFile(prompt, content);
    validate(agentConfigSchema, { prompt }, 'config');
    assert.throws(() =>
      validate(
        agentConfigSchema,
        { prompt, maxContextBytes: 120000 },
        'config',
      ),
    );
    let invoked = false;
    const context = new RuntimeContext().extend({
      directory: root,
      artifacts: new FileArtifacts(join(root, 'artifacts')),
      readEvidence: async (refs, options) => {
        assert.deepEqual(refs, ['measurement']);
        assert.deepEqual(options, { view: 'execution' });
        return {};
      },
      invokeAgent: async (_binding, request) => {
        invoked = true;
        const cwd = string(request.cwd);
        assert.match(
          await readFile(join(cwd, 'AGENTS.md'), 'utf8'),
          /Read context\/instructions\.md/,
        );
        assert.ok(
          (
            await readFile(join(cwd, 'context/instructions.md'), 'utf8')
          ).startsWith(`${content}\n\n`),
        );
        return {
          edits: [{ path: 'context/notes.md', content: 'Editable note' }],
          reason: 'Record a note in the candidate tree',
        };
      },
    });
    const result = await requestEdit(
      { prompt },
      { goal: 'Improve', evidenceRefs: ['measurement'] },
      null,
      context,
    );
    assert.equal(invoked, true);
    assert.deepEqual(result.edits, [
      { path: 'context/notes.md', content: 'Editable note' },
    ]);
    await assert.rejects(
      prepareAgentProject(
        context,
        'Read the supplied files',
        { 'candidate/node_modules/input.txt': 'Snapshot input' },
        [],
        [],
      ),
      /Agent project file cannot be captured/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const legacy of ['old-project', 'old-contract'] as const) {
  test(`editor rejects a pending ${legacy} receipt instead of repeating its Agent request`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-editor-replay-'));
    try {
      const prompt = join(root, 'prompt.md');
      await writeFile(prompt, 'Propose edits.');
      const facts = new FileFacts(join(root, 'facts'));
      await facts.write('calls', 'editing-call', { status: 'running' });
      let invocations = 0;
      const context = new RuntimeContext().extend({
        callId: 'editing-call',
        directory: root,
        artifacts: new FileArtifacts(join(root, 'artifacts')),
        facts,
        readEvidence: async () => ({}),
        invokeAgent: async (binding, request) => {
          invocations++;
          await facts.write('calls', 'editing-call', {
            status: 'running',
            recoveredFrom: 'previous-editor-attempt',
          });
          await facts.write('calls', 'prior-agent', {
            callId: 'prior-agent',
            parentCallId: 'editing-call',
            bindingId: binding,
            status: legacy === 'old-project' ? 'succeeded' : 'running',
            input:
              legacy === 'old-project'
                ? { ...request, cwd: join(root, 'legacy-project') }
                : { goal: request.goal, prompt: 'Legacy Agent input' },
          });
          return { edits: [], reason: 'No changes' };
        },
      });
      await requestEdit({ prompt }, { goal: 'Improve' }, null, context);
      await assert.rejects(
        requestEdit({ prompt }, { goal: 'Improve' }, null, context),
        /Agent edit input differs from existing call prior-agent; inspect and reconcile the receipt/,
      );
      assert.equal(invocations, 1);
    } finally {
      assert.equal(root.startsWith(join(tmpdir(), 'rsi-editor-replay-')), true);
      await rm(root, { recursive: true, force: true });
    }
  });
}
