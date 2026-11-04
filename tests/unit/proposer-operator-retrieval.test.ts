import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext } from '../../src/contracts/index.js';
import {
  readEmbeddingIdentity,
  retrieveStaticKnowledge,
} from '../../src/plugins/proposer-operator/retrieval.js';
import type {
  EmbeddingConfig,
  StaticIssue,
} from '../../src/plugins/proposer-operator/schema.js';

const issue: StaticIssue = {
  issue_type: 'core_partition',
  issue_summary: 'Independent row work uses a fixed grid',
  problematic_code: ['grid = (1,)'],
  evidence: ['The source contains one fixed program'],
};
const digest = (bytes: string): string =>
  createHash('sha256').update(bytes).digest('hex');

async function fixture(mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'operator-retrieval-test-'));
  const modelDirectory = join(directory, 'model');
  await mkdir(modelDirectory);
  await writeFile(
    join(modelDirectory, 'weights.bin'),
    'fixed local model bytes',
  );
  const identityFile = join(directory, 'identity.json');
  await writeFile(
    identityFile,
    JSON.stringify({
      schemaVersion: 'rsi.operator-embedding-identity/v1',
      model: { id: mode, revision: 'test' },
      encoding: {
        queryPromptName: 'query',
        normalizeEmbeddings: true,
        device: 'cpu',
        batchSize: 32,
      },
      files: [
        { path: 'weights.bin', sha256: digest('fixed local model bytes') },
      ],
    }),
  );
  const worker = join(directory, 'fake-python.mjs');
  await writeFile(
    worker,
    `#!/usr/bin/env node\nimport {readFile,writeFile} from 'node:fs/promises';\nconst args=process.argv;const input=JSON.parse(await readFile(args[args.indexOf('--request')+1],'utf8'));const identity=JSON.parse(await readFile(input.identityFile,'utf8'));\nif(identity.model.id.startsWith('descendant')){const {spawn}=await import('node:child_process');const {dirname,join}=await import('node:path');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();await writeFile(join(dirname(args[args.indexOf('--request')+1]),'descendant.pid'),String(child.pid));if(identity.model.id==='descendant-hang'){setInterval(()=>{},1000);await new Promise(()=>{});}}\nif(identity.model.id==='exit'){process.stderr.write('worker failed');process.exit(7);}\nif(identity.model.id==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}\nif(identity.model.id==='oversize'){process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000);await new Promise(()=>{});}\nconst result={schemaVersion:'rsi.operator-retrieval/v1',embeddingDigest:input.embeddingDigest,resourcesDigest:input.resourcesDigest,matches:[],knowledgeContext:'',omitted:{techniques:[],examples:[]},model:identity.model,runtime:{python:'fixture',sentenceTransformers:'fixture',transformers:'fixture',torch:'fixture'}};\nif(identity.model.id==='wrong-identity')result.embeddingDigest='0'.repeat(64);\nawait writeFile(args[args.indexOf('--response')+1],JSON.stringify(result));\n`,
  );
  await chmod(worker, 0o755);
  const config: EmbeddingConfig = {
    python: worker,
    modelDirectory,
    identityFile,
    device: 'cpu',
    timeoutMs: 2000,
    similarityThreshold: 0.6,
  };
  const context = new RuntimeContext().extend({
    directory: join(directory, 'call'),
    signal: new AbortController().signal,
  });
  return { directory, config, context };
}

test('local retrieval owns one CPU worker and preserves a normal empty match with identity evidence', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const identity = await readEmbeddingIdentity(f.config);
  assert.equal(
    identity.digest,
    digest(await readFile(f.config.identityFile, 'utf8')),
  );
  const result = await retrieveStaticKnowledge([issue], f.config, f.context);
  assert.deepEqual(result.matches, []);
  assert.equal(result.knowledgeContext, '');
  assert.equal(result.embeddingDigest, identity.digest);
  const request = JSON.parse(
    await readFile(join(f.context.directory, 'retrieval/request.json'), 'utf8'),
  );
  assert.equal(request.device, 'cpu');
  assert.deepEqual(request.issues, [issue]);
  const recorded = JSON.parse(
    await readFile(join(f.context.directory, 'retrieval/result.json'), 'utf8'),
  );
  assert.deepEqual(recorded, result);
});

test('embedding identity rejects changed, unlisted or missing model bytes before worker launch', async (t) => {
  for (const change of ['changed', 'unlisted', 'missing']) {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    if (change === 'changed')
      await writeFile(
        join(f.config.modelDirectory, 'weights.bin'),
        'different',
      );
    if (change === 'unlisted')
      await writeFile(join(f.config.modelDirectory, 'other.bin'), 'unlisted');
    if (change === 'missing')
      await rm(join(f.config.modelDirectory, 'weights.bin'));
    await assert.rejects(
      retrieveStaticKnowledge([issue], f.config, f.context),
      /identity|model|digest|file/i,
    );
  }
});

test('worker failure, malformed identity and unbounded logs never become retrieval misses', async (t) => {
  for (const mode of ['exit', 'wrong-identity', 'oversize']) {
    const f = await fixture(mode);
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    await assert.rejects(
      retrieveStaticKnowledge([issue], f.config, f.context),
      /worker|identity|output|log/i,
    );
  }
});

test('timeout and cancellation close the worker before retrieval rejects', async (t) => {
  for (const cancel of [false, true]) {
    const f = await fixture('hang');
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const controller = new AbortController();
    const promise = retrieveStaticKnowledge(
      [issue],
      { ...f.config, timeoutMs: cancel ? 2000 : 150 },
      f.context.extend({ signal: controller.signal }),
    );
    const timer = cancel
      ? setTimeout(() => controller.abort(new Error('explicit cancel')), 150)
      : null;
    try {
      await assert.rejects(promise, /timeout|cancel/i);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const evidence = JSON.parse(
      await readFile(
        join(f.context.directory, 'retrieval/process.json'),
        'utf8',
      ),
    );
    assert.equal(evidence.cleanup, 'confirmed');
    assert.throws(() => process.kill(evidence.pid, 0), /ESRCH/);
  }
});

test('retrieval kills same-group descendants on both successful close and timeout', async (t) => {
  for (const mode of ['descendant-success', 'descendant-hang']) {
    const f = await fixture(mode);
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const promise = retrieveStaticKnowledge(
      [issue],
      { ...f.config, timeoutMs: mode === 'descendant-hang' ? 3000 : 10000 },
      f.context,
    );
    if (mode === 'descendant-hang') await assert.rejects(promise, /timeout/);
    else await promise;
    const pid = Number(
      await readFile(
        join(f.context.directory, 'retrieval/descendant.pid'),
        'utf8',
      ),
    );
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
});
