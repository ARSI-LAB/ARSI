import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  readdir,
  readFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { InferenceConfig } from '../../src/plugins/application-inference/schema.js';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanTree,
  checkTarget,
  parseTarget,
} from '../../src/plugins/shared/file-application/target.js';

test('Target validates baseline changes and rejects protected paths and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-target-'));
  try {
    await writeFile(join(root, 'prompt.md'), 'before');
    await writeFile(join(root, 'agent.yaml'), '{}');
    const before = await scanTree(root);
    const target = parseTarget({
      schemaVersion: 'rsi.target/v1',
      id: 'test',
      entries: [
        {
          path: 'prompt.md',
          kind: 'file',
          description: 'instructions',
          changes: ['modify'],
          content: { encoding: 'utf-8', maxBytes: 100 },
        },
      ],
      protected: ['agent.yaml'],
      constraints: { maxChangedFiles: 1, maxChangedBytes: 100 },
    });
    await writeFile(join(root, 'prompt.md'), 'after');
    assert.equal(checkTarget(before, await scanTree(root), target).length, 1);
    await writeFile(join(root, 'agent.yaml'), 'changed');
    assert.throws(
      () =>
        checkTarget(
          before,
          {
            ...before,
            'agent.yaml': {
              ...before['agent.yaml'],
              content: Buffer.from('changed').toString('base64'),
            },
          },
          target,
        ),
      /protected|authorized/,
    );
    await mkdir(join(root, 'outside'));
    await symlink(
      join(root, 'outside'),
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(scanTree(root), /symbolic|symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Target rejects traversal and unsupported edit types before writes', () => {
  assert.throws(
    () =>
      parseTarget({
        schemaVersion: 'rsi.target/v1',
        id: 'test',
        entries: [
          {
            path: '../outside',
            kind: 'file',
            description: 'bad',
            changes: ['modify'],
          },
        ],
      }),
    /relative|path/,
  );
  assert.throws(
    () =>
      parseTarget({
        schemaVersion: 'rsi.target/v1',
        id: 'test',
        entries: [
          { path: 'x', kind: 'file', description: 'bad', changes: ['rename'] },
        ],
      }),
    /changes/,
  );
});

import {
  type Candidate,
  RuntimeContext,
  type JsonObject,
} from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { createFileApplication } from '../../src/plugins/shared/file-application/files.js';
import { inferenceDefinition } from '../../src/plugins/application-inference/index.js';
import { validateSkills } from '../../src/plugins/application-agentbundle/skills.js';
import { digest } from '../../src/shared/json.js';

function fixtureServices(root: string): RuntimeContext {
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const facts = new FileFacts(join(root, '.rsi/facts'));
  const candidates = new Map<string, Candidate>();
  return new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, 'custom-runtime-data'),
    artifacts,
    facts,
    workspaces: new FileWorkspaces(join(root, '.rsi/workspaces'), artifacts),
    async readCandidate(ref) {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error('Missing candidate');
      return candidate;
    },
    async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
      const context = this;
      const ref = `candidate-${candidates.size}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: context.experimentId,
      });
      return ref;
    },
    async recordMeasurement() {
      throw new Error('unused');
    },
    async readMeasurement() {
      throw new Error('unused');
    },
    async application() {
      throw new Error('unused');
    },
    async applicationMetadata() {
      return {};
    },
    async invokeAgent() {
      throw new Error('unused');
    },
    async readEvidence() {
      throw new Error('unused');
    },
    async invoke() {
      throw new Error('unused');
    },
    async charge() {},
    async withInstance() {
      throw new Error('unused');
    },
  });
}
function context(
  root: string,
  signal: AbortSignal = new AbortController().signal,
): RuntimeContext {
  return new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'call',
    bindingId: 'application',
    idempotencyKey: 'call',
    directory: join(root, 'calls/call'),
    signal,
    cleanup: AbortSignal.timeout(5000),
  });
}
const tinyTarget: JsonObject = {
  schemaVersion: 'rsi.target/v1',
  id: 'test-target',
  entries: [
    {
      path: 'prompt.md',
      kind: 'file',
      description: 'prompt',
      changes: ['modify'],
    },
  ],
};

test('AgentBundle validates Skill metadata and content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-bundle-skills-'));
  const directory = join(root, '.agents/skills/example');
  const skill = join(directory, 'SKILL.md');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      skill,
      '---\nname: example\ndescription: Example skill\n---\nInstructions',
    );
    await validateSkills(root);
    for (const [content, error] of [
      ['Instructions', /frontmatter is missing/],
      ['---\nname: [\n---\nInstructions', /frontmatter is invalid/],
      ['---\nname: example\n---\nInstructions', /description/],
      [
        '---\nname: example\ndescription: Example skill\n---\n',
        /body is empty/,
      ],
    ] satisfies [string, RegExp][]) {
      await writeFile(skill, content);
      await assert.rejects(validateSkills(root), error);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('commit requires matching parent identity and seals a validated candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-commit-'));
  const services = fixtureServices(root);
  const ctx = context(root).extend(services);
  try {
    const baseline = join(root, 'baseline');
    await import('node:fs/promises').then((fs) => fs.mkdir(baseline));
    await writeFile(join(baseline, 'prompt.md'), 'before');
    const application = await createFileApplication(
      { target: { schema: tinyTarget }, baseline: { directory: baseline } },
      services,
      {
        capability: 'test',
        async verify() {
          return {};
        },
        async acquire() {
          return {};
        },
        async release() {},
        async dispose() {},
      },
    );
    const initial = await application.execute(
      { action: 'initialize' },
      ctx.extend(services),
    );
    assert.equal(initial.action, 'initialize');
    assert.ok(
      initial && typeof initial === 'object' && !Array.isArray(initial),
    );
    const parent = String(initial.initialCandidateRef),
      candidate = await ctx.readCandidate(parent);
    const edit = await services.workspaces.create(
      candidate.artifactRef,
      parent,
    );
    await writeFile(join(edit.directory, 'prompt.md'), 'after');
    const result = await application.execute(
      { action: 'commit', parentCandidateRef: parent, editRef: edit.ref },
      ctx.extend(services),
    );
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    assert.equal(result.action, 'commit');
    assert.equal(result.status, 'created');
    const wrong = await services.workspaces.create(
      candidate.artifactRef,
      'wrong-parent',
    );
    await assert.rejects(
      application.execute(
        { action: 'commit', parentCandidateRef: parent, editRef: wrong.ref },
        ctx.extend(services),
      ),
      /identity mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owned inference instance is ready, releases idempotently, and cleans cancelled startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-inference-'));
  const services = fixtureServices(root);
  const ctx = context(root).extend(services);
  const baseline = join(root, 'baseline');
  await import('node:fs/promises').then((fs) => fs.mkdir(baseline));
  await writeFile(join(baseline, 'prompt.md'), 'prompt');
  await writeFile(
    join(baseline, 'server.mjs'),
    "import {createServer} from 'node:http';createServer((req,res)=>{res.statusCode=req.url==='/health'?200:503;res.end('ok')}).listen(Number(process.argv[2]),'127.0.0.1');",
  );
  const config = {
    target: { schema: tinyTarget },
    baseline: { directory: baseline },
    start: {
      argv: [
        process.execPath,
        { resource: 'workspace', path: 'server.mjs' },
        { resource: 'port' },
      ],
    },
    endpoint: { model: 'fixture' },
    healthcheck: { path: '/health', intervalMs: 10, timeoutMs: 1000 },
    shutdown: { gracePeriodMs: 100 },
  } satisfies InferenceConfig;
  const app = await inferenceDefinition.create(config, services);
  try {
    const initialized = await app.execute(
      { action: 'initialize' },
      ctx.extend(services),
    );
    assert.equal(initialized.action, 'initialize');
    assert.ok(
      initialized &&
        typeof initialized === 'object' &&
        !Array.isArray(initialized),
    );
    const candidateRef = String(initialized.initialCandidateRef);
    const ready = await app.execute(
      {
        action: 'acquire',
        candidateRef,
        instanceId: 'first',
        capability: 'inference-endpoint',
      },
      ctx.extend(services),
    );
    assert.ok(ready && typeof ready === 'object' && !Array.isArray(ready));
    assert.equal(ready.action, 'acquire');
    const execution = ready.execution;
    assert.ok(
      execution && typeof execution === 'object' && !Array.isArray(execution),
    );
    const endpoint = String(execution.baseUrl);
    assert.equal((await fetch(endpoint.replace('/v1', '/health'))).status, 200);
    const running = await services.facts.read(
      'application-inference-processes',
      'first',
    );
    assert.equal(running.status, 'running');
    assert.equal(typeof running.pid, 'number');
    assert.ok(String(running.lockDirectory).startsWith(services.dataDirectory));
    const instance = await services.facts.read('instances', 'first');
    assert.equal(instance.pid, undefined);
    assert.equal(instance.lockDirectory, undefined);
    assert.equal(instance.commandDigest, undefined);
    await assert.rejects(
      app.execute(
        {
          action: 'acquire',
          candidateRef,
          instanceId: 'busy',
          capability: 'inference-endpoint',
        },
        ctx.extend(services),
      ),
      /already leased/,
    );
    assert.equal((await fetch(endpoint.replace('/v1', '/health'))).status, 200);
    const restarted = await inferenceDefinition.create(config, services);
    await assert.rejects(
      restarted.execute(
        { action: 'release', instanceId: 'first' },
        ctx.extend(services),
      ),
      /outcome unknown after restart/,
    );
    await restarted.dispose();
    await app.execute(
      { action: 'release', instanceId: 'first' },
      ctx.extend(services),
    );
    await app.execute(
      { action: 'release', instanceId: 'first' },
      ctx.extend(services),
    );
    assert.equal(
      (await services.facts.read('application-inference-processes', 'first'))
        .status,
      'stopped',
    );
    assert.deepEqual(
      await readdir(
        join(services.dataDirectory, 'application-inference', 'service-locks'),
      ),
      [],
    );
    await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(300) }));
    const cancelledApp = await inferenceDefinition.create(
      {
        ...config,
        healthcheck: { path: '/never', intervalMs: 10, timeoutMs: 1000 },
      },
      services,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 75);
    await assert.rejects(
      cancelledApp.execute(
        {
          action: 'acquire',
          candidateRef,
          instanceId: 'cancelled',
          capability: 'inference-endpoint',
        },
        context(root, controller.signal).extend(services),
      ),
    );
    await cancelledApp.dispose();
    assert.equal(
      (
        await services.facts.read(
          'application-inference-processes',
          'cancelled',
        )
      ).status,
      'stopped',
    );
    assert.deepEqual(
      await readdir(
        join(services.dataDirectory, 'application-inference', 'service-locks'),
      ),
      [],
    );
    for (const [instanceId, override] of [
      ['spawn-error', { start: { argv: [join(root, 'missing-executable')] } }],
      ['before-spawn', { start: { ...config.start, cwd: '../outside' } }],
      [
        'readiness-timeout',
        { healthcheck: { path: '/never', intervalMs: 10, timeoutMs: 100 } },
      ],
    ] satisfies [string, Partial<InferenceConfig>][]) {
      const failing = await inferenceDefinition.create(
        { ...config, ...override },
        services,
      );
      try {
        await assert.rejects(
          failing.execute(
            {
              action: 'acquire',
              candidateRef,
              instanceId,
              capability: 'inference-endpoint',
            },
            ctx.extend(services),
          ),
        );
        assert.equal(
          (
            await services.facts.read(
              'application-inference-processes',
              instanceId,
            )
          ).status,
          'stopped',
        );
        assert.deepEqual(
          await readdir(
            join(
              services.dataDirectory,
              'application-inference',
              'service-locks',
            ),
          ),
          [],
        );
      } finally {
        await failing.dispose();
      }
    }
    const second = await app.execute(
      {
        action: 'acquire',
        candidateRef,
        instanceId: 'second',
        capability: 'inference-endpoint',
      },
      ctx.extend(services),
    );
    assert.ok(second);
    await app.execute(
      { action: 'release', instanceId: 'second' },
      ctx.extend(services),
    );
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('inference recovery checks private process state and lock ownership before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-inference-recovery-'));
  const services = fixtureServices(root);
  const ctx = context(root).extend(services);
  const app = await inferenceDefinition.create(
    {
      target: { schema: tinyTarget },
      baseline: { directory: root },
      start: { argv: [process.execPath, '-e', ''] },
      endpoint: { model: 'fixture' },
    },
    services,
  );
  try {
    const lock = join(
      services.dataDirectory,
      'application-inference',
      'service-locks',
      digest({}),
    );
    await mkdir(lock, { recursive: true });
    const ownerPath = join(lock, 'owner.json');
    await writeFile(ownerPath, JSON.stringify({ instanceId: 'recover' }));
    await services.facts.write('instances', 'recover', {
      instanceId: 'recover',
      experimentId: ctx.experimentId,
      status: 'unknown',
      workspaceRef: null,
    });
    const release = (): Promise<unknown> =>
      app.execute(
        { action: 'release', instanceId: 'recover' },
        ctx.extend(services),
      );
    const save = (
      pid: number | null,
      status = 'running',
      lockDirectory = lock,
    ): Promise<void> =>
      services.facts.write('application-inference-processes', 'recover', {
        instanceId: 'recover',
        pid,
        status,
        lockDirectory,
      });
    await save(null, 'starting');
    await assert.rejects(release(), /outcome unknown after restart/);
    await save(process.pid);
    await assert.rejects(release(), /outcome unknown after restart/);
    const retired = spawn(process.execPath, ['-e', '']);
    await once(retired, 'exit');
    assert.ok(retired.pid);
    await save(retired.pid, 'running', join(root, 'other-lock'));
    await assert.rejects(release(), /lock identity mismatch/);
    await save(retired.pid);
    await writeFile(
      ownerPath,
      JSON.stringify({ instanceId: 'another-instance' }),
    );
    await assert.rejects(release(), /lock owner mismatch/);
    assert.equal(
      JSON.parse(await readFile(ownerPath, 'utf8')).instanceId,
      'another-instance',
    );
    await writeFile(ownerPath, JSON.stringify({ instanceId: 'recover' }));
    await release();
    await release();
    assert.equal(
      (await services.facts.read('application-inference-processes', 'recover'))
        .status,
      'stopped',
    );
    assert.equal(
      (await services.facts.read('instances', 'recover')).status,
      'released',
    );
    assert.deepEqual(await readdir(join(lock, '..')), []);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
