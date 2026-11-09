import test from 'node:test';
import { RuntimeContext } from '../../src/contracts/index.js';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Candidate } from '../../src/contracts/index.js';
import { inferencebenchContract } from '../../src/contracts/plugin-types/inferencebench.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { inferenceDefinition } from '../../src/plugins/application-inference/index.js';
import type { RemoteInferenceConfig } from '../../src/plugins/application-inference/schema.js';
import { createRemoteBackend } from '../../src/plugins/application-inference/remote.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { validate } from '../../src/shared/schema.js';
import { digest, object } from '../../src/shared/json.js';

function servicesFor(root: string): RuntimeContext {
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const candidates = new Map<string, Candidate>();
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  return new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    artifacts,
    facts: new FileFacts(join(root, '.rsi/facts')),
    workspaces: new FileWorkspaces(join(root, '.rsi/workspaces'), artifacts),
    async readCandidate(ref) {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error('missing candidate');
      return candidate;
    },
    async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
      const ref = `candidate-${candidates.size}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
    recordMeasurement: unused,
    readMeasurement: unused,
    application: unused,
    applicationMetadata: unused,
    invokeAgent: unused,
    readEvidence: unused,
    invoke: unused,
    withInstance: unused,
    async charge() {},
  });
}
function call(
  context: RuntimeContext,
  signal = new AbortController().signal,
): RuntimeContext {
  return context.extend({
    experimentId: 'remote-test',
    callId: 'remote-call',
    bindingId: 'application',
    idempotencyKey: 'remote-call',
    directory: join(context.rootDirectory, '.rsi/calls/test'),
    signal,
    cleanup: AbortSignal.timeout(10000),
  });
}
async function fixture(
  onHealth?: () => void,
  startupFailure?: 'start' | 'poll' | 'cleanup',
): Promise<{
  root: string;
  config: RemoteInferenceConfig;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-remote-'));
  const server = createServer((_request, response) => {
    onHealth?.();
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const origin = `http://127.0.0.1:${address.port}`;
  await mkdir(join(root, 'baseline'));
  await writeFile(
    join(root, 'baseline/tuning.json'),
    '{"max_num_seqs":32,"max_num_batched_tokens":1024}\n',
  );
  await writeFile(
    join(root, 'fake.mjs'),
    `import {readFile,writeFile,appendFile} from 'node:fs/promises';
let text='';for await(const chunk of process.stdin)text+=chunk;
const r=JSON.parse(text), d={root:${JSON.stringify(root)}};
const startupFailure=${JSON.stringify(startupFailure ?? null)};
if('deployment' in r)throw Error('Unexpected deployment payload');
await appendFile(d.root+'/requests.jsonl',JSON.stringify(r)+'\\n');
let saved=null;try{saved=JSON.parse(await readFile(d.root+'/remote.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
const identity={verified:true,host:'fixture',modelIdentity:'model-digest',software:'vllm-fixture',devices:['fixture-device']};
let out;
if(r.action==='describe-parameters'){
 out={parameters:{enable_prefix_caching:{flag:'--enable-prefix-caching',kind:'boolean'},gpu_memory_utilization:{flag:'--gpu-memory-utilization',kind:'number'}}};
}else if(r.action==='start'){
 if(startupFailure){
  saved={status:'startup-failed',instanceId:r.instanceId,parametersDigest:r.parametersDigest,reason:'Configured launch diagnostic'};
  await writeFile(d.root+'/remote.json',JSON.stringify(saved));
  out=startupFailure==='poll'?{...saved,status:'starting'}:saved;
 }
 else if(r.memoryUtilization>0.97)out={status:'capacity-rejected',instanceId:r.instanceId,parametersDigest:r.parametersDigest};
 else {saved={status:'ready',instanceId:r.instanceId,parametersDigest:r.parametersDigest,resources:identity};await writeFile(d.root+'/remote.json',JSON.stringify(saved));out=saved}
}else if(r.action==='stop'){if(startupFailure==='cleanup')out={...saved,status:'unknown'};else {if(saved&&saved.instanceId!==r.instanceId)throw Error('ownership mismatch');await writeFile(d.root+'/remote.json','null');out={status:'stopped',instanceId:r.instanceId};}}
else out=saved??{status:'stopped',instanceId:r.instanceId};
process.stdout.write(JSON.stringify(out));`,
  );
  const config: RemoteInferenceConfig = {
    target: {
      schema: {
        schemaVersion: 'rsi.target/v1',
        id: 'remote-target',
        entries: [
          {
            path: 'tuning.json',
            kind: 'file',
            description: 'engine tuning',
            changes: ['modify'],
          },
        ],
      },
    },
    baseline: { directory: './baseline' },
    remote: {
      script: './fake.mjs',
      executable: process.execPath,
      parametersFile: 'tuning.json',
      calibration: {
        start: 0.98,
        min: 0.96,
        step: 0.01,
        maxNumSeqs: 64,
        maxNumBatchedTokens: 2048,
      },
    },
    endpoint: { origin, basePath: '/v1', model: 'test-model' },
    healthcheck: { timeoutMs: 1000, intervalMs: 10 },
  };
  return {
    root,
    config,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('remote startup rejection is recoverable only after the owned service is released', async () => {
  for (const failure of ['start', 'poll', 'cleanup'] as const) {
    const f = await fixture(undefined, failure);
    const services = servicesFor(f.root);
    const config = {
      ...f.config,
      remote: { script: f.config.remote.script, executable: process.execPath },
    };
    const application = await inferenceDefinition.create(config, services);
    try {
      const initial = await application.execute(
        { action: 'initialize' },
        call(services),
      );
      assert.equal(initial.action, 'initialize');
      await assert.rejects(
        application.execute(
          {
            action: 'acquire',
            candidateRef: initial.initialCandidateRef,
            instanceId: 'rejected',
            capability: 'inference-endpoint',
          },
          call(services),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          if (failure === 'cleanup') {
            assert.equal('status' in error && error.status, 'unknown');
            assert.match(error.message, /cleanup could not confirm release/);
          } else {
            assert.equal(error.name, 'InferenceStartupError');
            assert.match(error.message, /Configured launch diagnostic/);
          }
          return true;
        },
      );
      const instance = await services.facts.read('instances', 'rejected');
      assert.equal(
        instance.status,
        failure === 'cleanup' ? 'unknown' : 'released',
      );
    } finally {
      try {
        if (failure === 'cleanup') await assert.rejects(application.dispose());
        else await application.dispose();
      } finally {
        await f.close();
      }
    }
  }
});

test('a direct inference evaluation fails and releases a rejected remote instance', async () => {
  const f = await fixture(undefined, 'start');
  const registry = new Registry();
  const manager = new Manager({ registry, rootDirectory: f.root });
  try {
    registry.registerOperation(inferenceDefinition);
    registry.registerOperation({
      id: 'test.inference-evaluator',
      contract: inferencebenchContract,
      configSchema: { type: 'object' },
      async create() {
        return {
          async execute(input, context) {
            return context.withInstance(
              String(object(input).candidateRef),
              'inference-endpoint',
              async () =>
                assert.fail('Evaluator cannot use a rejected instance'),
            );
          },
          async dispose() {},
        };
      },
    });
    const policyPath = join(f.root, 'policy.yaml');
    await writeFile(
      policyPath,
      stringify({
        schemaVersion: 'rsi.policy/v1',
        id: 'test.inference-evaluation',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        require: {
          evaluator: { contract: inferencebenchContract.id },
        },
        steps: [
          {
            id: 'check',
            type: 'invoke',
            use: 'evaluator',
            with: {
              candidateRef: '${{ application.initialCandidate }}',
            },
          },
        ],
        output: '${{ steps.check.output }}',
      }),
    );
    registry.registerPolicy('test.inference-evaluation', policyPath);
    const recipePath = join(f.root, 'recipe.yaml');
    await writeFile(
      recipePath,
      stringify({
        schemaVersion: 'rsi.recipe/v1',
        id: 'trial',
        application: {
          plugin: inferenceDefinition.id,
          config: {
            ...f.config,
            remote: {
              script: f.config.remote.script,
              executable: process.execPath,
            },
          },
        },
        policy: { id: 'test.inference-evaluation', config: {}, input: {} },
        bindings: {
          evaluator: { plugin: 'test.inference-evaluator', config: {} },
        },
        budget: { operations: 10, elapsedWallMs: 10000 },
      }),
    );
    await assert.rejects(
      manager.run(recipePath, { id: 'trial' }),
      /Configured launch diagnostic/,
    );
    const result = await manager.get('trial');
    assert.equal(result.status, 'failed');
    assert.match(String(result.error), /Configured launch diagnostic/);
    const instances = await manager.facts.list('instances');
    assert.deepEqual(
      instances.map((record) => record.status),
      ['released'],
    );
  } finally {
    await manager.dispose();
    await registry.dispose();
    await f.close();
  }
});

test('remote inference schema accepts script lifecycle and excludes local start', async () => {
  const f = await fixture();
  try {
    validate(inferenceDefinition.configSchema, f.config, 'config');
    assert.throws(() =>
      validate(
        inferenceDefinition.configSchema,
        {
          ...f.config,
          remote: { ...object(f.config.remote), deployment: './obsolete.json' },
        },
        'config',
      ),
    );
    assert.throws(() =>
      validate(
        inferenceDefinition.configSchema,
        { ...f.config, start: { argv: ['vllm'] } },
        'config',
      ),
    );
  } finally {
    await f.close();
  }
});

test('remote inference calibrates once, uses supplied endpoint and explicitly stops remote instances', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const parameters = {
    max_num_seqs: 32,
    max_num_batched_tokens: 1024,
    kv_cache_dtype: 'fp8',
    enforce_eager: false,
    speculative_config: { method: 'mtp', num_speculative_tokens: 3 },
    optional_value: null,
    numeric_or_string: [1, 'auto'],
  };
  await writeFile(
    join(f.root, 'baseline/tuning.json'),
    JSON.stringify(parameters),
  );
  const app = await inferenceDefinition.create(f.config, services);
  try {
    const initialized = await app.execute(
      { action: 'initialize' },
      call(services),
    );
    if (initialized.action !== 'initialize')
      throw new Error('unexpected initialize');
    for (const instanceId of ['first', 'second']) {
      const acquired = await app.execute(
        {
          action: 'acquire',
          candidateRef: initialized.initialCandidateRef,
          instanceId,
          capability: 'inference-endpoint',
        },
        call(services),
      );
      assert.equal(acquired.action, 'acquire');
      if (acquired.action !== 'acquire') throw new Error('unexpected acquire');
      assert.equal(
        acquired.execution.baseUrl,
        object(f.config.endpoint).origin + '/v1',
      );
      assert.equal(
        object(acquired.execution.resources).gpuMemoryUtilization,
        0.97,
      );
      // A fresh Application can reconcile and stop remote ownership after restart.
      const releaser =
        instanceId === 'second'
          ? await inferenceDefinition.create(f.config, services)
          : app;
      await releaser.execute({ action: 'release', instanceId }, call(services));
      await releaser.execute({ action: 'release', instanceId }, call(services));
      if (releaser !== app) await releaser.dispose();
    }
    const requests = (await readFile(join(f.root, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    const starts = requests.filter((r) => r.action === 'start');
    assert.deepEqual(starts[2]!.parameters, parameters);
    assert.equal(starts[2]!.parametersDigest, digest(parameters));
    assert.deepEqual(
      starts.map((r) => r.memoryUtilization),
      [0.98, 0.97, 0.97, 0.97],
    );
    assert.deepEqual(
      starts.slice(0, 2).map((r) => object(r.parameters).max_num_seqs),
      [64, 64],
    );
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'remote.json'), 'utf8')),
      null,
    );
  } finally {
    await app.dispose();
    await f.close();
  }
});

test('remote readiness cancellation explicitly cleans owned remote service', async () => {
  const f = await fixture();
  const remote = { ...f.config.remote };
  delete remote.calibration;
  const config = { ...f.config, remote };
  const endpoint = config.endpoint;
  const bad = {
    ...config,
    endpoint: { ...endpoint, origin: 'http://127.0.0.1:1' },
    healthcheck: { intervalMs: 10 },
  };
  const services = servicesFor(f.root);
  const app = await inferenceDefinition.create(bad, services);
  try {
    const initial = await app.execute({ action: 'initialize' }, call(services));
    if (initial.action !== 'initialize')
      throw new Error('unexpected initialize');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      app.execute(
        {
          action: 'acquire',
          candidateRef: initial.initialCandidateRef,
          instanceId: 'cancelled',
          capability: 'inference-endpoint',
        },
        call(services, controller.signal),
      ),
    );
    const requests = (await readFile(join(f.root, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    assert.ok(requests.some((r) => r.action === 'stop'));
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'remote.json'), 'utf8')),
      null,
    );
  } finally {
    await app.dispose();
    await f.close();
  }
});

for (const healthTimeout of [undefined, 40_000]) {
  test(
    healthTimeout === undefined
      ? 'remote readiness inherits the configured lifecycle timeout'
      : 'an explicit healthcheck timeout overrides the lifecycle timeout for readiness',
    async (t) => {
      const deadline = new AbortController();
      const timedOut = new Error('Configured lifecycle deadline expired');
      const f = await fixture(() => deadline.abort(timedOut));
      const services = servicesFor(f.root);
      const remoteTimeout = 30_000;
      const remote = { ...f.config.remote, timeoutMs: remoteTimeout };
      delete remote.calibration;
      const app = await inferenceDefinition.create(
        {
          ...f.config,
          remote,
          healthcheck: {
            intervalMs: 10,
            ...(healthTimeout === undefined
              ? {}
              : { timeoutMs: healthTimeout }),
          },
        },
        services,
      );
      const nativeTimeout = AbortSignal.timeout;
      const timeouts = t.mock.method(AbortSignal, 'timeout', (ms: number) =>
        ms === remoteTimeout && !deadline.signal.aborted
          ? deadline.signal
          : nativeTimeout(ms),
      );
      try {
        const initial = await app.execute(
          { action: 'initialize' },
          call(services),
        );
        if (initial.action !== 'initialize')
          throw new Error('unexpected initialize');
        const acquiring = app.execute(
          {
            action: 'acquire',
            candidateRef: initial.initialCandidateRef,
            instanceId: 'explicit-timeout',
            capability: 'inference-endpoint',
          },
          call(services),
        );
        if (healthTimeout === undefined)
          await assert.rejects(acquiring, (error) => error === timedOut);
        else assert.equal((await acquiring).action, 'acquire');
        assert.equal(deadline.signal.aborted, true);
      } finally {
        timeouts.mock.restore();
        await app.dispose();
        await f.close();
      }
    },
  );
}

test('remote ownership conflict is retained as unknown and never replaces the other service', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const app = await inferenceDefinition.create(f.config, services);
  const other = {
    status: 'ready',
    instanceId: 'other-experiment-instance',
    parametersDigest: 'other-parameters',
  };
  await writeFile(join(f.root, 'remote.json'), JSON.stringify(other));
  try {
    const initialized = await app.execute(
      { action: 'initialize' },
      call(services),
    );
    if (initialized.action !== 'initialize')
      throw new Error('unexpected initialize');
    await assert.rejects(
      app.execute(
        {
          action: 'acquire',
          candidateRef: initialized.initialCandidateRef,
          instanceId: 'conflict',
          capability: 'inference-endpoint',
        },
        call(services),
      ),
      /ownership mismatch/,
    );
    assert.equal(
      (await services.facts.read('instances', 'conflict')).status,
      'unknown',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(f.root, 'remote.json'), 'utf8')),
      other,
    );
    const requests = (await readFile(join(f.root, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    assert.equal(requests.filter((r) => r.action === 'start').length, 0);
    await assert.rejects(app.dispose());
    // Restore the external service only in this controlled fixture before cleanup.
    await writeFile(join(f.root, 'remote.json'), 'null');
    await app.execute(
      { action: 'release', instanceId: 'conflict' },
      call(services),
    );
  } finally {
    await app.dispose();
    await f.close();
  }
});

test('remote repeated acquire rechecks ownership instead of returning a stale endpoint', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const app = await inferenceDefinition.create(f.config, services);
  let restarted: Awaited<ReturnType<typeof inferenceDefinition.create>> | null =
    null;
  let saved = '';
  try {
    const initialized = await app.execute(
      { action: 'initialize' },
      call(services),
    );
    if (initialized.action !== 'initialize')
      throw new Error('unexpected initialize');
    const input = {
      action: 'acquire' as const,
      candidateRef: initialized.initialCandidateRef,
      instanceId: 'reused',
      capability: 'inference-endpoint',
    };
    await app.execute(input, call(services));
    saved = await readFile(join(f.root, 'remote.json'), 'utf8');
    await writeFile(
      join(f.root, 'remote.json'),
      JSON.stringify({
        ...object(JSON.parse(saved)),
        instanceId: 'replacement',
      }),
    );
    restarted = await inferenceDefinition.create(f.config, services);
    await assert.rejects(
      restarted.execute(input, call(services)),
      /ownership mismatch/,
    );
  } finally {
    if (saved) await writeFile(join(f.root, 'remote.json'), saved);
    if (restarted) await restarted.dispose();
    await app.dispose();
    await f.close();
  }
});

test('remote resumed ready instance is released when its new owner disposes', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const app = await inferenceDefinition.create(f.config, services);
  let restarted: Awaited<ReturnType<typeof inferenceDefinition.create>> | null =
    null;
  try {
    const initialized = await app.execute(
      { action: 'initialize' },
      call(services),
    );
    if (initialized.action !== 'initialize')
      throw new Error('unexpected initialize');
    const input = {
      action: 'acquire' as const,
      candidateRef: initialized.initialCandidateRef,
      instanceId: 'resumed',
      capability: 'inference-endpoint',
    };
    await app.execute(input, call(services));
    restarted = await inferenceDefinition.create(f.config, services);
    await restarted.execute(input, call(services));
    await restarted.dispose();
    assert.equal(
      (await services.facts.read('instances', 'resumed')).status,
      'released',
    );
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'remote.json'), 'utf8')),
      null,
    );
  } finally {
    if (restarted) await restarted.dispose();
    await app.dispose();
    await f.close();
  }
});

test('remote release retries remove only the matching leftover local lock after a confirmed stop', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const backend = await createRemoteBackend(f.config, services);
  const lock = join(
    services.dataDirectory,
    'application-inference',
    'remote-locks',
    digest({ origin: object(f.config.endpoint).origin }),
  );
  const request = {
    instanceId: 'stopped-before-unlock',
    experimentId: 'remote-test',
    parametersDigest: 'parameters',
  };
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        instanceId: request.instanceId,
        experimentId: request.experimentId,
        request,
      }),
    );
    await services.facts.write(
      'application-inference-remote',
      request.instanceId,
      { status: 'stopped', lockDirectory: null, request },
    );
    await backend.release({ instanceId: request.instanceId }, call(services));
    await assert.rejects(readFile(join(lock, 'owner.json')), /ENOENT/);
    await backend.release({ instanceId: request.instanceId }, call(services));
    await mkdir(lock, { recursive: true });
    const other = {
      instanceId: 'other-instance',
      experimentId: 'other-experiment',
    };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(other));
    await backend.release({ instanceId: request.instanceId }, call(services));
    assert.deepEqual(
      JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')),
      other,
    );
    const conflictingExperiment = {
      instanceId: request.instanceId,
      experimentId: 'other-experiment',
      request,
    };
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify(conflictingExperiment),
    );
    await assert.rejects(
      backend.release({ instanceId: request.instanceId }, call(services)),
      /lock owner mismatch/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')),
      conflictingExperiment,
    );
  } finally {
    await backend.dispose();
    await f.close();
  }
});

test('remote release recovers published ownership intent before the first private fact was written', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const backend = await createRemoteBackend(f.config, services);
  const lock = join(
    services.dataDirectory,
    'application-inference',
    'remote-locks',
    digest({ origin: object(f.config.endpoint).origin }),
  );
  const request = {
    instanceId: 'owner-intent-only',
    experimentId: 'remote-test',
    parametersDigest: 'parameters',
  };
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        instanceId: request.instanceId,
        experimentId: request.experimentId,
        request,
      }),
    );
    await backend.release({ instanceId: request.instanceId }, call(services));
    await assert.rejects(readFile(join(lock, 'owner.json')), /ENOENT/);
    const requests = (await readFile(join(f.root, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    assert.deepEqual(
      requests.map((value) => value.action),
      ['stop'],
    );
  } finally {
    await backend.dispose();
    await f.close();
  }
});

test('remote acquisition failure before its first fact does not publish or retain a local lock', async () => {
  const f = await fixture();
  const services = servicesFor(f.root);
  const failingServices = services.extend({
    facts: {
      read: services.facts.read.bind(services.facts),
      list: services.facts.list.bind(services.facts),
      async write() {
        throw new Error('injected fact failure');
      },
    },
  });
  const backend = await createRemoteBackend(f.config, failingServices);
  try {
    const identity = await backend.verify(
      join(f.root, 'baseline'),
      call(services),
    );
    await assert.rejects(
      backend.acquire(
        join(f.root, 'baseline'),
        identity,
        'failed-before-fact',
        call(services),
      ),
      /injected fact failure/,
    );
    assert.deepEqual(
      await readdir(
        join(services.dataDirectory, 'application-inference', 'remote-locks'),
      ),
      [],
    );
  } finally {
    await backend.dispose();
    await f.close();
  }
});

test('remote discovery gives the proposer installed choices and treats memory as a candidate factor', async () => {
  const f = await fixture();
  try {
    const services = servicesFor(f.root);
    const context = call(services);
    const { calibration: _calibration, ...remote } = f.config.remote;
    const config = {
      ...f.config,
      remote: { ...remote, discoverParameters: true },
    };
    await writeFile(
      join(f.root, 'baseline/tuning.json'),
      '{"enable_prefix_caching":false,"gpu_memory_utilization":0.91}\n',
    );
    const app = await inferenceDefinition.create(config, services);
    try {
      const initialized = await app.execute({ action: 'initialize' }, context);
      assert.equal(initialized.action, 'initialize');
      assert.deepEqual(
        Object.keys(object(initialized.target.parameterCatalog)),
        ['enable_prefix_caching', 'gpu_memory_utilization'],
      );
      const output = await app.execute(
        {
          action: 'acquire',
          candidateRef: initialized.initialCandidateRef,
          capability: 'inference-endpoint',
          instanceId: 'discovered',
        },
        context,
      );
      assert.equal(output.action, 'acquire');
      assert.equal(output.execution.gpuMemoryUtilization, 0.91);
      assert.equal(
        object(output.execution.resources).gpuMemoryUtilization,
        undefined,
      );
      await app.execute(
        { action: 'release', instanceId: 'discovered' },
        context,
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await f.close();
  }
});
