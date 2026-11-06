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
import {
  loadOperatorResources,
  readKnowledgeResources,
} from '../../src/plugins/proposer-operator/service.js';
import { prepareKnowledgeFixture } from '../fixtures/operator-proposer/setup.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'operator-resources-'));
  const resourcesDirectory = join(directory, 'external');
  await prepareKnowledgeFixture(resourcesDirectory);
  const retrievalScript = join(directory, 'worker.py');
  await writeFile(retrievalScript, '# external worker fixture\n');
  return { directory, resourcesDirectory, retrievalScript };
}

test('operator resources load an explicitly supplied knowledge bundle and identify its worker', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const first = await readKnowledgeResources(f);
  assert.equal(first.manifest.schemaVersion, 'rsi.operator-knowledge/v1');
  await writeFile(f.retrievalScript, '# revised external worker fixture\n');
  const second = await readKnowledgeResources(f);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.workerDigest, second.workerDigest);
});

test('operator resource loading rejects modified knowledge and paths outside the supplied bundle', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const path = join(f.resourcesDirectory, 'knowledge/technique.json');
  const original = await readFile(path);
  await writeFile(path, 'changed');
  await assert.rejects(readKnowledgeResources(f), /resource changed/);
  await writeFile(path, original);
  await rm(path);
  await symlink(f.retrievalScript, path);
  await assert.rejects(readKnowledgeResources(f), /escapes/);
});

test('configured operator prompts supply stage content and participate in resource identity', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const promptsDirectory = join(f.directory, 'prompts');
  await mkdir(promptsDirectory);
  for (const stage of [
    'diagnose',
    'diagnose-metrics',
    'generate',
    'generate-metrics',
    'repair',
    'summarize',
  ])
    await writeFile(join(promptsDirectory, `${stage}.md`), `Custom ${stage}\n`);
  const config = {
    agentRef: 'agent',
    promptsDirectory,
    task: { directory: f.directory },
    embedding: {
      ...f,
      python: 'python',
      modelDirectory: f.directory,
      identityFile: join(f.directory, 'identity.json'),
      device: 'cpu' as const,
      timeoutMs: 1000,
      similarityThreshold: 0.6,
    },
  };
  const first = await loadOperatorResources(config);
  assert.equal(first.prompts.generate, 'Custom generate\n');
  assert.equal(first.prompts['diagnose-metrics'], 'Custom diagnose-metrics\n');
  assert.equal(first.metricsGenerate, 'Custom generate-metrics\n');
  await writeFile(
    join(promptsDirectory, 'generate.md'),
    'Revised generation\n',
  );
  const second = await loadOperatorResources(config);
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.knowledgeDigest, second.knowledgeDigest);
  await rm(join(promptsDirectory, 'repair.md'));
  await assert.rejects(
    loadOperatorResources(config),
    /promptsDirectory(?=.*repair\.md)(?=.*read)/i,
  );
  await writeFile(join(promptsDirectory, 'repair.md'), ' \r\n\t');
  await assert.rejects(
    loadOperatorResources(config),
    /promptsDirectory.*repair\.md.*empty/i,
  );
});
