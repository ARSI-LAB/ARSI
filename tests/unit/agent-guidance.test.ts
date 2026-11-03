import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as editing from '../../src/plugins/shared/agent-editing/index.js';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';

test('agent prompt loads optional recursive guidance afresh without rewriting the base', async () => {
  assert.equal(typeof editing.loadAgentPrompt, 'function');
  const root = await mkdtemp(join(tmpdir(), 'rsi-guidance-'));
  try {
    const prompt = join(root, 'prompt.md');
    const guidance = join(root, 'guidance');
    const base = 'Base prompt.\r\n';
    await writeFile(prompt, base);
    await mkdir(join(guidance, 'nested'), { recursive: true });
    assert.equal(await editing.loadAgentPrompt({ prompt }), base);
    assert.equal(await editing.loadAgentPrompt({ prompt, guidance }), base);
    await writeFile(join(guidance, 'empty.md'), '');
    await writeFile(join(guidance, 'ignored.txt'), 'Do not include');
    assert.equal(await editing.loadAgentPrompt({ prompt, guidance }), base);
    await writeFile(join(guidance, 'z.md'), 'Last guidance.');
    await writeFile(join(guidance, 'nested', 'a.md'), 'Nested guidance.');
    await writeFile(join(guidance, 'a.md'), 'First guidance.');
    const first = await editing.loadAgentPrompt({ prompt, guidance });
    assert.ok(first.startsWith(base));
    assert.ok(
      first.indexOf('First guidance.') < first.indexOf('Nested guidance.'),
    );
    assert.ok(
      first.indexOf('Nested guidance.') < first.indexOf('Last guidance.'),
    );
    assert.equal(first.includes('Do not include'), false);
    await writeFile(join(guidance, 'a.md'), 'Revised guidance.');
    const next = await editing.loadAgentPrompt({ prompt, guidance });
    assert.ok(next.includes('Revised guidance.'));
    assert.equal(next.includes('First guidance.'), false);
    assert.equal(next.split(base).length, 2);
    assert.equal(await readFile(prompt, 'utf8'), base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent prompt rejects symbolic links in the guidance tree and at its root', async () => {
  assert.equal(typeof editing.loadAgentPrompt, 'function');
  const root = await mkdtemp(join(tmpdir(), 'rsi-guidance-link-'));
  try {
    const prompt = join(root, 'prompt.md');
    const guidance = join(root, 'guidance');
    await writeFile(prompt, 'Base');
    await mkdir(guidance);
    await mkdir(join(root, 'outside'));
    const linked = join(guidance, 'linked');
    await symlink(
      join(root, 'outside'),
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      editing.loadAgentPrompt({ prompt, guidance }),
      /symbolic|symlink/,
    );
    await assert.rejects(
      editing.loadAgentPrompt({ prompt, guidance: linked }),
      /symbolic|symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editor delivers guidance revisions on subsequent requests without appending to the base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-editor-guidance-'));
  try {
    const prompt = join(root, 'prompt.md');
    const guidance = join(root, 'guidance');
    await writeFile(prompt, 'Base editor prompt.');
    await mkdir(guidance);
    const artifacts = new FileArtifacts(join(root, 'artifacts'));
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected service');
    };
    const services: RuntimeContext = new RuntimeContext().extend({
      rootDirectory: root,
      dataDirectory: root,
      artifacts,
      facts: new FileFacts(join(root, 'facts')),
      workspaces: new FileWorkspaces(join(root, 'workspaces'), artifacts),
      readCandidate: unused,
      recordCandidate: unused,
      recordMeasurement: unused,
      readMeasurement: unused,
      application: unused,
      applicationMetadata: unused,
      invoke: unused,
      withInstance: unused,
      charge: unused,
      readEvidence: async () => ({}),
      invokeAgent: async (request) => ({ edits: [], reason: request.prompt }),
    });
    const context: RuntimeContext = new RuntimeContext().extend({
      experimentId: 'test',
      callId: 'test',
      bindingId: 'test',
      idempotencyKey: 'test',
      directory: root,
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    });
    const config = { prompt, guidance };
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
    assert.deepEqual(await editing.resourceFiles(snapshot, services), {
      'note.txt': 'editable text',
    });
    const malformed = await artifacts.putJson({
      kind: 'file-tree',
      files: [{ path: 'note.txt', mode: 0o644, base64: 'invalid!' }],
    });
    await assert.rejects(editing.resourceFiles(malformed, services), /bytes/);
    assert.equal(
      (
        await editing.requestEdit(
          config,
          { goal: 'Improve' },
          null,
          context.extend(services),
        )
      ).reason,
      'Base editor prompt.',
    );
    await writeFile(join(guidance, 'rule.md'), 'Use evidence.');
    const first = await editing.requestEdit(
      config,
      { goal: 'Improve' },
      null,
      context.extend(services),
    );
    assert.match(String(first.reason), /Use evidence\./);
    await writeFile(join(guidance, 'rule.md'), 'Check evidence applicability.');
    const next = await editing.requestEdit(
      config,
      { goal: 'Improve' },
      null,
      context.extend(services),
    );
    assert.match(String(next.reason), /Check evidence applicability\./);
    assert.equal(String(next.reason).includes('Use evidence.'), false);
    assert.equal(String(next.reason).split('Base editor prompt.').length, 2);
    assert.equal(await readFile(prompt, 'utf8'), 'Base editor prompt.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
