import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type Candidate,
  type JsonObject,
} from '../../src/contracts/index.js';
import {
  parseKernelExecution,
  kernelExecutionSchema,
} from '../../src/plugins/application-kernel/schema.js';
import { createApplicationKernel } from '../../src/plugins/application-kernel/index.js';
import { configSchema } from '../../src/plugins/application-kernel/schema.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { object, string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

const source = 'def kernel_function(x):\n    return x\n';
const target: JsonObject = {
  schemaVersion: 'rsi.target/v1',
  id: 'kernel-opt',
  entries: [
    {
      path: 'input.py',
      kind: 'file',
      description: 'Triton Ascend operator source',
      changes: ['modify'],
      content: { encoding: 'utf-8' },
    },
    {
      path: 'config.json',
      kind: 'file',
      description: 'kernel config parameters',
      changes: ['modify'],
      content: { encoding: 'utf-8' },
    },
  ],
};

// The fake lifecycle script speaks the start/status/stop JSON protocol and
// keeps its single-instance state in <root>/instance.json. Scenario keys in
// the config parameters select the outcome: reject_precheck simulates the
// deterministic correctness precheck rejecting the candidate, fail_build a
// broken compile, reject_capacity a busy build resource.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-kernel-opt-'));
  t.after(async () => {
    try {
      await application.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const baseline = join(root, 'baseline');
  await mkdir(baseline);
  await writeFile(join(baseline, 'input.py'), source);
  await writeFile(
    join(baseline, 'config.json'),
    '{"BLOCK_SIZE":1024,"num_warps":4}\n',
  );
  await writeFile(
    join(root, 'fake.mjs'),
    `import {readFile,writeFile} from 'node:fs/promises';
let text='';for await(const chunk of process.stdin)text+=chunk;
const r=JSON.parse(text), d={root:${JSON.stringify(root)}};
let saved=null;try{saved=JSON.parse(await readFile(d.root+'/instance.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
const identity={verified:true,host:'local-host',modelIdentity:'build-digest',software:'cann-fixture',devices:['0']};
let out;
if(r.action==='start'){
 if(r.parameters.reject_capacity===1)out={status:'capacity-rejected',instanceId:r.instanceId,parametersDigest:r.parametersDigest};
 else if(r.parameters.fail_build===1)out={status:'failed',instanceId:r.instanceId,parametersDigest:r.parametersDigest,failure:{message:'kernel compile failed',logPath:'/tmp/build.log'}};
 else if(r.parameters.reject_precheck===1){saved={status:'rejected',instanceId:r.instanceId,parametersDigest:r.parametersDigest,failure:{message:'precheck checksum gate failed: TypeError: multiple values for argument',logPath:'precheck.log'}};await writeFile(d.root+'/instance.json',JSON.stringify(saved));out=saved}
 else{saved={status:'ready',instanceId:r.instanceId,parametersDigest:r.parametersDigest,resources:identity};await writeFile(d.root+'/instance.json',JSON.stringify(saved));out=saved}
}else if(r.action==='stop'){if(saved&&saved.instanceId!==r.instanceId)throw Error('ownership mismatch');await writeFile(d.root+'/instance.json','null');out={status:'stopped',instanceId:r.instanceId};}
else out=saved??{status:'stopped',instanceId:r.instanceId};
process.stdout.write(JSON.stringify(out));`,
  );
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const facts = new FileFacts(join(root, '.rsi/facts'));
  const workspaces = new FileWorkspaces(
    join(root, '.rsi/workspaces'),
    artifacts,
  );
  const context = new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    experimentId: 'kernel-opt-experiment',
    callId: 'kernel-opt-call',
    bindingId: 'application',
    idempotencyKey: 'kernel-opt-call',
    directory: join(root, '.rsi/calls/kernel-opt-call'),
    signal: new AbortController().signal,
    cleanup: AbortSignal.timeout(15000),
    artifacts,
    facts,
    workspaces,
    async readCandidate(ref: string): Promise<Candidate> {
      const value = await facts.read('candidates', ref);
      return {
        ref,
        artifactRef: string(value.artifactRef),
        parentRef: value.parentRef === null ? null : string(value.parentRef),
        experimentId: string(value.experimentId),
      };
    },
    async recordCandidate(
      this: RuntimeContext,
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string> {
      const ref = `candidate-${(await facts.list('candidates')).length}`;
      await facts.write('candidates', ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
  });
  const config = {
    target: { schema: target },
    baseline: { directory: baseline },
    lifecycle: {
      script: './fake.mjs',
      executable: process.execPath,
      timeoutMs: 30000,
    },
    healthcheck: { intervalMs: 10, timeoutMs: 10000 },
    shutdown: { gracePeriodMs: 5000 },
  };
  const application = await createApplicationKernel(config, context);
  const initial = await application.execute({ action: 'initialize' }, context);
  assert.ok(initial.action === 'initialize');
  return { root, baseline, config, context, application, initial };
}

async function commitConfig(
  f: Awaited<ReturnType<typeof fixture>>,
  parameters: JsonObject,
): Promise<string> {
  const parent = await f.context.readCandidate(f.initial.initialCandidateRef);
  const edit = await f.context.workspaces.create(
    parent.artifactRef,
    parent.ref,
  );
  await writeFile(
    join(edit.directory, 'config.json'),
    `${JSON.stringify(parameters)}\n`,
  );
  const committed = await f.application.execute(
    { action: 'commit', parentCandidateRef: parent.ref, editRef: edit.ref },
    f.context,
  );
  assert.ok(committed.action === 'commit' && committed.status === 'created');
  await f.context.workspaces.release(edit.ref);
  return committed.candidateRef;
}

test('kernel lifecycle schema accepts the scripted config and rejects foreign sections', async (t) => {
  const f = await fixture(t);
  validate(configSchema, f.config, 'config');
  // The remote section belongs to other applications; the lifecycle is local.
  await assert.rejects(
    Promise.resolve().then(() =>
      validate(
        configSchema,
        { ...f.config, remote: { script: './x' } },
        'config',
      ),
    ),
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      validate(configSchema, { ...f.config, lifecycle: {} }, 'config'),
    ),
  );
});

test('lifecycle-backed kernel acquisition produces a complete KernelExecution with tiling parameters', async (t) => {
  const f = await fixture(t);
  const candidateRef = await commitConfig(f, {
    BLOCK_SIZE: 2048,
    num_warps: 8,
  });
  const acquired = await f.application.execute(
    {
      action: 'acquire',
      candidateRef,
      instanceId: 'inst-1',
      capability: 'kernel-source',
    },
    f.context,
  );
  assert.ok(acquired.action === 'acquire');
  validate(kernelExecutionSchema, acquired.execution);
  const execution = parseKernelExecution(acquired.execution);
  assert.equal(execution.kind, 'kernel-source');
  assert.equal(execution.format, 'triton-ascend');
  assert.equal(execution.entryPoint, 'kernel_function');
  assert.equal(
    execution.sourceDigest,
    createHash('sha256').update(source).digest('hex'),
  );
  assert.equal(
    execution.artifactRef,
    (await f.context.readCandidate(candidateRef)).artifactRef,
  );
  // The leased workspace carries the source plus the tiling parameters, so
  // the evaluator's readTiling resolves without extra state lookups.
  assert.deepEqual(
    JSON.parse(
      await readFile(join(execution.directory, 'config.json'), 'utf8'),
    ),
    { BLOCK_SIZE: 2048, num_warps: 8 },
  );
  const released = await f.application.execute(
    { action: 'release', instanceId: 'inst-1' },
    f.context,
  );
  assert.ok(released.action === 'release' && released.status === 'released');
});

test('a precheck-rejected candidate acquires as an unverified execution and releases the lease', async (t) => {
  const f = await fixture(t);
  const candidateRef = await commitConfig(f, {
    BLOCK_SIZE: 1024,
    num_warps: 4,
    reject_precheck: 1,
  });
  // The rejection resolves instead of throwing: a failed acquire call aborts
  // the whole experiment, while the evaluator consumes the unverified
  // execution and records the auditable failed measurement.
  const rejected = await f.application.execute(
    {
      action: 'acquire',
      candidateRef,
      instanceId: 'inst-rejected',
      capability: 'kernel-source',
    },
    f.context,
  );
  assert.ok(rejected.action === 'acquire');
  const execution = object(rejected.execution);
  assert.deepEqual(execution.resources, { verified: false });
  assert.match(
    string(execution.rejection && object(execution.rejection).message),
    /precheck checksum gate failed.*multiple values for argument/,
  );
  assert.equal(
    string(execution.rejection && object(execution.rejection).logPath),
    'precheck.log',
  );
  // The evaluator's withInstance releases the rejected instance before the
  // failed measurement is recorded; mirror that here.
  await f.application.execute(
    { action: 'release', instanceId: 'inst-rejected' },
    f.context,
  );
  // The lease must be free again so the next optimization round can acquire
  // an instance.
  const retry = await f.application.execute(
    {
      action: 'acquire',
      candidateRef: f.initial.initialCandidateRef,
      instanceId: 'inst-retry',
      capability: 'kernel-source',
    },
    f.context,
  );
  assert.ok(retry.action === 'acquire');
  const verified = parseKernelExecution(retry.execution);
  assert.equal(
    JSON.parse(await readFile(join(verified.directory, 'config.json'), 'utf8'))
      .BLOCK_SIZE,
    1024,
  );
  await f.application.execute(
    { action: 'release', instanceId: 'inst-retry' },
    f.context,
  );
});

test('build failure and capacity rejection surface as explicit acquisition errors', async (t) => {
  const f = await fixture(t);
  const brokenRef = await commitConfig(f, {
    BLOCK_SIZE: 1024,
    num_warps: 4,
    fail_build: 1,
  });
  await assert.rejects(
    f.application.execute(
      {
        action: 'acquire',
        candidateRef: brokenRef,
        instanceId: 'inst-build',
        capability: 'kernel-source',
      },
      f.context,
    ),
    /kernel compile failed/,
  );
  const busyRef = await commitConfig(f, {
    BLOCK_SIZE: 1024,
    num_warps: 4,
    reject_capacity: 1,
  });
  await assert.rejects(
    f.application.execute(
      {
        action: 'acquire',
        candidateRef: busyRef,
        instanceId: 'inst-capacity',
        capability: 'kernel-source',
      },
      f.context,
    ),
    /rejected the candidate/,
  );
});
