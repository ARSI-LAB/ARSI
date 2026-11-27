import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  agentConfigSchema,
  requestEdit,
  resourceFiles,
} from '../../src/plugins/shared/agent-editing/index.js';
import { prepareAgentProject } from '../../src/index.js';
import { createArtifactSelector } from '../../src/plugins/selector-artifacts/service.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

test('selector sends the rendered natural-language body and keeps candidate evidence in its project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-selector-message-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = join(root, 'prompt.md');
  const template = join(root, 'task.md');
  await writeFile(prompt, 'Review the deliverables.');
  await writeFile(
    template,
    '  Compare {{candidateCount}} candidates in {{candidatesPath}}.\n\n{{rubric}}  \n',
  );
  const context = new RuntimeContext().extend({
    directory: root,
    artifacts: new FileArtifacts(join(root, 'artifacts')),
    readEvidence: async () => ({ delivery: 'artifact text' }),
    invokeAgent: async (_binding, request) => {
      assert.equal(
        request.message,
        '  Compare 1 candidates in context/candidates.json.\n\nPrioritize correctness.  \n',
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(request.cwd, 'context/candidates.json'), 'utf8'),
        ),
        [{ label: 0, delivery: { delivery: 'artifact text' } }],
      );
      assert.deepEqual(request.outputSchema.required, [
        'selectedIndex',
        'reason',
      ]);
      return { selectedIndex: 0, reason: 'Correct' };
    },
  });
  const operation = await createArtifactSelector(
    { prompt, messageTemplates: { default: template } },
    context,
  );
  const result = await operation.execute(
    {
      rubric: 'Prioritize correctness.',
      candidates: [
        { candidateRef: 'candidate', measurementRef: 'measurement' },
      ],
    },
    context,
  );
  assert.equal(result.candidateRef, 'candidate');
});

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
        const metadata = JSON.parse(
          await readFile(join(cwd, 'context/input.json'), 'utf8'),
        );
        assert.equal(Object.hasOwn(metadata, 'memory'), false);
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
          edits: [{ path: 'context/notes.md', content: 'Tampered note' }],
          reason: 'Record a note in the candidate tree',
        };
      },
    });
    await assert.rejects(
      requestEdit(
        { prompt },
        { goal: 'Improve', evidenceRefs: ['measurement'] },
        null,
        context,
        'Improve the supplied files.',
      ),
      /read-only context/,
    );
    assert.equal(invoked, true);
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

test('the editor reads text resources and the current prompt for each request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-editor-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = join(root, 'prompt.md');
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const context = new RuntimeContext().extend({
    directory: root,
    artifacts,
    readEvidence: async () => ({}),
    invokeAgent: async (_binding, request) => ({
      edits: [],
      reason: await readFile(join(string(request.cwd), 'AGENTS.md'), 'utf8'),
    }),
  });
  const snapshot = await artifacts.putJson({
    kind: 'file-tree',
    files: [
      {
        path: 'note.txt',
        mode: 0o644,
        base64: Buffer.from('editable text').toString('base64'),
      },
      {
        path: 'binary.dat',
        mode: 0o644,
        base64: Buffer.from([0, 255]).toString('base64'),
      },
    ],
  });
  assert.deepEqual(await resourceFiles(snapshot, context), {
    'note.txt': 'editable text',
  });
  const malformed = await artifacts.putJson({
    kind: 'file-tree',
    files: [{ path: 'note.txt', mode: 0o644, base64: 'invalid!' }],
  });
  await assert.rejects(resourceFiles(malformed, context), /bytes/);
  for (const instructions of [
    'Base editor prompt.',
    'Check the revised evidence.',
  ]) {
    await writeFile(prompt, instructions);
    const response = await requestEdit(
      { prompt },
      { goal: 'Improve' },
      snapshot,
      context,
      'Improve the supplied files.',
    );
    assert.ok(string(response.reason).startsWith(instructions + '\n'));
  }
});
