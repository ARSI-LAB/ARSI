import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { artifactSelectorDefinition } from '../../src/plugins/selector-artifacts/index.js';

test('registered artifact selector explicitly requests delivery evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-artifact-selector-'));
  const registry = new Registry();
  try {
    const prompt = join(root, 'prompt.md');
    const guidance = join(root, 'guidance');
    await writeFile(prompt, 'Choose the best delivery.'.repeat(6000));
    await mkdir(guidance);
    await writeFile(join(guidance, 'selection.md'), 'Prefer clear delivery.');
    const artifacts = new FileArtifacts(join(root, 'artifacts'));
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected service');
    };
    let reads = 0;
    const prompts: string[] = [];
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
      readEvidence: async (refs, options) => {
        assert.deepEqual(refs, ['measurement']);
        assert.deepEqual(options, { view: 'delivery' });
        reads++;
        return { delivery: 'public result' };
      },
      invokeAgent: async (request) => {
        assert.ok(Buffer.byteLength(String(request.prompt)) > 120000);
        prompts.push(String(request.prompt));
        return { selectedIndex: 0, reason: 'Best delivery' };
      },
    });
    const context: RuntimeContext = new RuntimeContext().extend({
      experimentId: 'exp',
      callId: 'call',
      bindingId: 'selector',
      idempotencyKey: 'call',
      directory: root,
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    });
    registry.registerOperation(artifactSelectorDefinition);
    const operation = await registry
      .get(artifactSelectorDefinition.id)
      .create({ prompt, guidance }, services);
    try {
      const result = await operation.execute(
        {
          candidates: [
            { candidateRef: 'candidate', measurementRef: 'measurement' },
          ],
          rubric: 'Quality',
        },
        context.extend(services),
      );
      assert.equal(reads, 1);
      assert.ok(prompts[0]?.includes('Prefer clear delivery.'));
      await writeFile(
        join(guidance, 'selection.md'),
        'Prefer complete delivery.',
      );
      await operation.execute(
        {
          candidates: [
            { candidateRef: 'candidate', measurementRef: 'measurement' },
          ],
          rubric: 'Quality',
        },
        context.extend(services),
      );
      assert.ok(prompts[1]?.includes('Prefer complete delivery.'));
      assert.equal(prompts[1]?.includes('Prefer clear delivery.'), false);
      assert.equal(
        await readFile(prompt, 'utf8'),
        'Choose the best delivery.'.repeat(6000),
      );
      assert.equal(
        result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          result.candidateRef,
        'candidate',
      );
    } finally {
      await operation.dispose();
    }
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
