import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  agentConfigSchema,
  requestEdit,
} from '../../src/plugins/shared/agent-editing/index.js';
import { validate } from '../../src/shared/schema.js';

test('editor rejects removed context configuration and forwards large requests', async () => {
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
      readEvidence: async (refs, options) => {
        assert.deepEqual(refs, ['measurement']);
        assert.deepEqual(options, { view: 'execution' });
        return {};
      },
      invokeAgent: async (request) => {
        invoked = true;
        assert.equal(request.prompt, content);
        return { edits: [], reason: 'No change' };
      },
    });
    await requestEdit(
      { prompt },
      { goal: 'Improve', evidenceRefs: ['measurement'] },
      null,
      context,
    );
    assert.equal(invoked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
