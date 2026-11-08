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
import { FileArtifacts } from '../../src/runtime/storage/index.js';
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
