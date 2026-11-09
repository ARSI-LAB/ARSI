import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fingerprintConfig } from 'ember-evaluator';
import {
  agentContract,
  RuntimeContext,
  type Candidate,
  type JsonObject,
} from '../../src/contracts/index.js';
import { inferenceDefinition } from '../../src/plugins/application-inference/index.js';
import type { RemoteInferenceConfig } from '../../src/plugins/application-inference/schema.js';
import { inferencebenchDefinition } from '../../src/plugins/evaluator-inferencebench/index.js';
import { createInferencebench } from '../../src/plugins/evaluator-inferencebench/service.js';
import type { InferencebenchConfig } from '../../src/plugins/evaluator-inferencebench/schema.js';
import { createRuntime } from '../../src/runtime/context.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { digest, object, string } from '../../src/shared/json.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const wrapper = join(
  repository,
  'examples/artifacts/inference/vllm-optimization/scripts/vllm-ssh.py',
);
const fixtures = fileURLToPath(
  new URL('../fixtures/inference-ssh/', import.meta.url),
);
const execute = promisify(execFile);
const sshTest = process.platform === 'win32' ? test.skip : test;

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(
      join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'rsi-ssh-'),
    ),
  );
  const python = (
    await execute('python3', ['-c', 'import sys; print(sys.executable)'])
  ).stdout.trim();
  const launcher = join(root, 'remote-launcher.py');
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'remote'));
  await mkdir(join(root, 'baseline'));
  await copyFile(join(fixtures, 'fake-ssh.py'), join(root, 'bin/ssh'));
  await chmod(join(root, 'bin/ssh'), 0o755);
  await copyFile(join(fixtures, 'fake-vllm.py'), launcher);
  await writeFile(join(root, 'baseline/tuning.json'), '{"max_num_seqs":8}\n');
  const env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    RSI_SSH_FIXTURE_DIR: root,
    VLLM_SSH_HOST: 'fixture-host',
    VLLM_SSH_USER: 'fixture-user',
    VLLM_SSH_REMOTE_PYTHON: python,
    VLLM_SSH_REMOTE_LAUNCHER: launcher,
    VLLM_SSH_REMOTE_LAUNCHER_SHA256: createHash('sha256')
      .update(await readFile(launcher))
      .digest('hex'),
    VLLM_SSH_STATE_DIR: join(root, 'local'),
    VLLM_ASCEND_MODEL_PATH: '/fixture/model with spaces',
    VLLM_ASCEND_STATE_DIR: join(root, 'remote'),
    ASCEND_RT_VISIBLE_DEVICES: '0',
    VLLM_API_KEY: "fixture-secret-quote-'-$-value",
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(async () => {
    try {
      await execute(python, [join(root, 'bin/ssh'), '--cleanup']);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config: RemoteInferenceConfig = {
    target: {
      schema: {
        schemaVersion: 'rsi.target/v1',
        id: 'ssh-fixture',
        entries: [
          {
            path: 'tuning.json',
            kind: 'file',
            description: 'Parameters',
            changes: ['modify'],
          },
        ],
      },
    },
    baseline: { directory: './baseline' },
    remote: {
      script: wrapper,
      executable: python,
      discoverParameters: true,
      timeoutMs: 10000,
    },
    endpoint: { origin, basePath: '/v1', model: 'fixture-model' },
    healthcheck: { intervalMs: 10, timeoutMs: 5000 },
    shutdown: { gracePeriodMs: 10000 },
    credentials: { apiKeyEnv: 'VLLM_API_KEY' },
  };
  function request(action: string, instanceId = 'ssh-instance'): JsonObject {
    const parameters = { max_num_seqs: 8 };
    return {
      action,
      instanceId,
      experimentId: 'ssh-test',
      parameters,
      parametersDigest: digest(parameters),
      memoryUtilization: 0.9,
      endpoint: { origin, model: 'fixture-model' },
    };
  }
  async function invoke(
    payload: JsonObject,
    args = [wrapper],
  ): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        python,
        args,
        { timeout: 15000 },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(stderr || error.message, { cause: error }));
          else {
            try {
              resolve(object(JSON.parse(stdout)));
            } catch (error) {
              reject(error);
            }
          }
        },
      );
      child.stdin?.end(JSON.stringify(payload));
    });
  }
  async function records(path: string): Promise<JsonObject[]> {
    try {
      return (await readFile(join(root, path), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return [];
      throw error;
    }
  }
  async function released(): Promise<void> {
    await assert.rejects(readFile(join(root, 'remote/service.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(
      fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }),
    );
    for (const path of [
      join(root, 'local', String(port), 'owner.json'),
      join(root, 'remote/.ssh-bridge', String(port), 'current.json'),
    ]) {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    }
    const masters = (await records('ssh.jsonl')).filter(
      (entry) => entry.kind === 'master',
    );
    for (const master of masters) {
      await assert.rejects(readFile(string(master.socket)), { code: 'ENOENT' });
    }
  }
  return { root, python, origin, config, request, invoke, records, released };
}

function applicationContext(root: string): RuntimeContext {
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const candidates = new Map<string, Candidate>();
  const unused = async (): Promise<never> => {
    throw new Error('Unused service');
  };
  return new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    artifacts,
    facts: new FileFacts(join(root, '.rsi/facts')),
    workspaces: new FileWorkspaces(join(root, '.rsi/workspaces'), artifacts),
    async readCandidate(ref) {
      const candidate = candidates.get(ref);
      assert.ok(candidate);
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
    readMeasurement: unused,
    recordMeasurement: unused,
    application: unused,
    applicationMetadata: unused,
    invokeAgent: unused,
    readEvidence: unused,
    invoke: unused,
    withInstance: unused,
    async charge() {},
  });
}

function call(services: RuntimeContext): RuntimeContext {
  return services.extend({
    experimentId: 'ssh-test',
    callId: 'ssh-call',
    bindingId: 'application',
    idempotencyKey: 'ssh-call',
    directory: join(services.rootDirectory, '.rsi/calls/test'),
    signal: new AbortController().signal,
    cleanup: AbortSignal.timeout(15000),
  });
}

sshTest(
  'SSH wrapper repeats lifecycle calls without duplicating or retaining a service or tunnel',
  async (t) => {
    const f = await fixture(t);
    assert.ok(
      object(await f.invoke({ action: 'describe-parameters' })).parameters,
    );
    for (const instanceId of ['first', 'second']) {
      const payload = f.request('start', instanceId);
      for (const action of ['start', 'start', 'status']) {
        const response = await f.invoke({ ...payload, action });
        assert.equal(response.status, 'ready');
        assert.equal(response.instanceId, instanceId);
        assert.equal(response.parametersDigest, payload.parametersDigest);
        assert.equal((await fetch(`${f.origin}/health`)).status, 200);
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal(
          (await f.invoke({ ...payload, action: 'stop' })).status,
          'stopped',
        );
      }
      assert.equal(
        (await f.invoke({ ...payload, action: 'status' })).status,
        'stopped',
      );
      await f.released();
    }
    assert.equal((await f.records('remote/launches.jsonl')).length, 2);
    const sshCalls = (await f.records('ssh.jsonl')).filter(
      (entry) => entry.kind === 'argv',
    );
    assert.ok(sshCalls.length > 0);
    assert.ok(
      sshCalls.every(
        (entry) =>
          !JSON.stringify(entry.args).includes(process.env.VLLM_API_KEY!),
      ),
    );
  },
);

sshTest(
  'Remote generations reject delayed starts and stops while allowing instance ID reuse',
  async (t) => {
    const f = await fixture(t);
    const port = new URL(f.origin).port;
    const ownerPath = join(f.root, 'local', port, 'owner.json');
    const currentPath = join(
      f.root,
      'remote/.ssh-bridge',
      port,
      'current.json',
    );
    const request = f.request('start', 'reused-instance');
    assert.equal((await f.invoke(request)).status, 'ready');
    const oldOwner = object(JSON.parse(await readFile(ownerPath, 'utf8')));
    const replay = (action: string): Promise<JsonObject> =>
      f.invoke(
        {
          wrapper,
          request: { ...request, action },
          port: Number(port),
          generation: oldOwner.generation,
          configDigest: oldOwner.configDigest,
        },
        [join(fixtures, 'fake-ssh.py'), '--replay-bootstrap'],
      );
    assert.equal(
      (await f.invoke({ ...request, action: 'stop' })).status,
      'stopped',
    );
    await assert.rejects(
      replay('start'),
      /generation has already been stopped/,
    );
    assert.equal((await f.records('remote/launches.jsonl')).length, 1);
    await f.released();

    assert.equal((await f.invoke(request)).status, 'ready');
    const newOwner = object(JSON.parse(await readFile(ownerPath, 'utf8')));
    assert.notEqual(newOwner.generation, oldOwner.generation);
    assert.equal(newOwner.instanceId, oldOwner.instanceId);
    const current = await readFile(currentPath, 'utf8');
    const service = await readFile(join(f.root, 'remote/service.json'), 'utf8');
    await assert.rejects(replay('stop'), /generation or ownership mismatch/);
    assert.equal(await readFile(currentPath, 'utf8'), current);
    assert.equal(
      await readFile(join(f.root, 'remote/service.json'), 'utf8'),
      service,
    );
    assert.equal((await fetch(`${f.origin}/health`)).status, 200);
    assert.equal(
      (await f.invoke({ ...request, action: 'status' })).status,
      'ready',
    );
    assert.equal((await f.records('remote/launches.jsonl')).length, 2);
    assert.equal(
      (await f.invoke({ ...request, action: 'stop' })).status,
      'stopped',
    );
    await f.released();
  },
);

sshTest(
  'Application retains unknown ownership until remote stop and tunnel stop both succeed',
  async (t) => {
    const f = await fixture(t);
    const services = applicationContext(f.root);
    const application = await inferenceDefinition.create(f.config, services);
    try {
      const initial = await application.execute(
        { action: 'initialize' },
        call(services),
      );
      assert.equal(initial.action, 'initialize');
      if (initial.action !== 'initialize') throw new Error('Unexpected output');
      for (const failure of ['remote', 'tunnel']) {
        const instanceId = `failed-${failure}`;
        const flag = join(
          f.root,
          failure === 'remote' ? 'remote/fail-stop' : 'fail-tunnel-stop',
        );
        await writeFile(join(f.root, 'remote/fail-start'), 'fail');
        await writeFile(flag, 'fail');
        try {
          await assert.rejects(
            application.execute(
              {
                action: 'acquire',
                candidateRef: initial.initialCandidateRef,
                instanceId,
                capability: 'inference-endpoint',
              },
              call(services),
            ),
            /cleanup could not confirm release/,
          );
          assert.equal(
            (await services.facts.read('instances', instanceId)).status,
            'unknown',
          );
          if (failure === 'remote')
            assert.equal(
              object(
                JSON.parse(
                  await readFile(join(f.root, 'remote/service.json'), 'utf8'),
                ),
              ).instanceId,
              instanceId,
            );
        } finally {
          await rm(flag);
          await rm(join(f.root, 'remote/fail-start'));
        }
        const recovered = await inferenceDefinition.create(f.config, services);
        try {
          await recovered.execute(
            { action: 'release', instanceId },
            call(services),
          );
          await recovered.execute(
            { action: 'release', instanceId },
            call(services),
          );
          assert.equal(
            (await services.facts.read('instances', instanceId)).status,
            'released',
          );
          await f.released();
        } finally {
          await recovered.dispose();
        }
      }
    } finally {
      await application.dispose();
    }
  },
);

sshTest(
  'SSH wrapper does not take over an unrelated local listener or remote owner',
  async (t) => {
    const f = await fixture(t);
    const port = Number(new URL(f.origin).port);
    const foreign = createServer((_request, response) =>
      response.end('foreign'),
    );
    await new Promise<void>((resolve) =>
      foreign.listen(port, '127.0.0.1', resolve),
    );
    try {
      await assert.rejects(f.invoke(f.request('start')));
      assert.equal(await (await fetch(f.origin)).text(), 'foreign');
      await f.invoke(f.request('stop'));
      assert.equal(await (await fetch(f.origin)).text(), 'foreign');
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
    const foreignOwner = {
      status: 'ready',
      instanceId: 'foreign-instance',
      parametersDigest: 'foreign-digest',
    };
    await writeFile(
      join(f.root, 'remote/service.json'),
      JSON.stringify(foreignOwner),
    );
    for (const action of ['status', 'start', 'stop']) {
      await assert.rejects(f.invoke(f.request(action, 'other-instance')));
      assert.deepEqual(
        JSON.parse(await readFile(join(f.root, 'remote/service.json'), 'utf8')),
        foreignOwner,
      );
    }
  },
);

sshTest(
  'SSH cleanup removes only a dead socket on a free port and retains uncertain tunnels',
  async (t) => {
    const f = await fixture(t);
    for (const mode of ['dead', 'occupied', 'live']) {
      const request = f.request('start', `socket-${mode}`);
      assert.equal((await f.invoke(request)).status, 'ready');
      const masters = (await f.records('ssh.jsonl')).filter(
        (entry) => entry.kind === 'master',
      );
      const master = masters.at(-1);
      assert.ok(master);
      let foreign: ReturnType<typeof createServer> | undefined;
      const flag = join(f.root, 'fail-tunnel-check');
      if (mode === 'live') {
        await writeFile(flag, 'fail');
      } else {
        await execute(f.python, [
          join(fixtures, 'fake-ssh.py'),
          '--crash',
          string(master.socket),
        ]);
        if (mode === 'occupied') {
          foreign = createServer((_request, response) =>
            response.end('foreign'),
          );
          await new Promise<void>((resolve) =>
            foreign!.listen(
              Number(new URL(f.origin).port),
              '127.0.0.1',
              resolve,
            ),
          );
        }
      }
      try {
        if (mode !== 'dead') {
          await assert.rejects(f.invoke({ ...request, action: 'stop' }));
          const owner = object(
            JSON.parse(
              await readFile(
                join(f.root, 'local', new URL(f.origin).port, 'owner.json'),
                'utf8',
              ),
            ),
          );
          assert.equal(owner.instanceId, request.instanceId);
          if (foreign)
            assert.equal(await (await fetch(f.origin)).text(), 'foreign');
        }
      } finally {
        await rm(flag, { force: true });
        if (foreign)
          await new Promise<void>((resolve) => foreign!.close(() => resolve()));
      }
      assert.equal(
        (await f.invoke({ ...request, action: 'stop' })).status,
        'stopped',
      );
      await f.released();
    }
  },
);

const workload = {
  inputLength: 256,
  outputLength: 64,
  dataCount: 16,
  concurrency: 2,
  requestRate: 0,
  testType: 'stream',
  prefixCache: {
    enabled: false,
    prefixCount: 1,
    prefixRatio: 0,
    warmup: false,
    dp: 1,
    seed: 42,
  },
};
const taskId = `aisbench-${fingerprintConfig(workload).slice(-16)}`;

function snapshot(size: number): JsonObject {
  const latency = new Map([
    [8, 120],
    [16, 105],
    [24, 98],
  ]).get(size);
  assert.ok(latency);
  const bundleDigest = 'a'.repeat(64);
  return {
    digest: `fixture-${size}`,
    run: {
      runId: 'fixture-native',
      evaluationKind: 'performance',
      status: 'completed',
      taskIds: [taskId],
      source: {
        source: 'github:rayn-zzz/aisbench_auto_tools_prefix',
        revision: 'fixture',
        files: [],
        metadata: { bundleDigest },
      },
      identity: {
        evaluator: { name: 'fixture-sdk', version: '1' },
        runtime: { node: '24', platform: 'fixture', arch: 'fixture' },
      },
      solverProvenance: { bundleDigest, aisbenchVersion: '1.0.0' },
      pluginVersions: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    },
    records: [
      {
        key: { runId: 'fixture-native', taskId, attemptId: 'fixture-attempt' },
        evaluationKind: 'performance',
        executionStatus: 'completed',
        scoreStatus: 'not-applicable',
        cleanupStatus: 'cleaned',
        solve: {
          finalText: '',
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          observations: {
            schemaVersion: 1,
            kind: 'aisbench',
            workload,
            bundleDigest,
            aisbenchVersion: '1.0.0',
            rows: [
              {
                total_req: '16',
                qps: String(size),
                'TTFT P90': String(latency),
                'TPOT SLO_P90': '10',
              },
            ],
          },
        },
        verdict: { passed: null },
        errors: [],
        collection: { trajectory: 'not-produced', artifacts: 'complete' },
      },
    ],
    pendingTaskIds: [],
  };
}

sshTest(
  'Runtime parameter.agent uses the SSH Application through two SLO improvement rounds',
  async (t) => {
    const f = await fixture(t);
    const runtime = await createRuntime({
      rootDirectory: f.root,
      homeDirectory: false,
    });
    const measured: number[] = [];
    let proposals = 0;
    runtime.registry.registerOperation({
      ...inferencebenchDefinition,
      id: 'test.ssh-inferencebench',
      create: (config: InferencebenchConfig, services) =>
        createInferencebench(config, services, async ({ configPath }) => {
          const native = object(JSON.parse(await readFile(configPath, 'utf8')));
          const model = object(object(native.services).default);
          assert.equal(model.base_url, `${f.origin}/v1`);
          assert.equal(model.model, 'fixture-model');
          assert.equal(model.api_key, '${VLLM_API_KEY}');
          assert.equal((await fetch(`${f.origin}/health`)).status, 200);
          const state = object(
            JSON.parse(
              await readFile(join(f.root, 'remote/service.json'), 'utf8'),
            ),
          );
          const size = Number(object(state.parameters).max_num_seqs);
          assert.equal(state.parametersDigest, digest(state.parameters));
          measured.push(size);
          return { kind: 'local', exitCode: 0, snapshot: snapshot(size) };
        }),
    });
    runtime.registry.registerOperation({
      id: 'test.ssh-agent',
      contract: agentContract,
      configSchema: { type: 'object' },
      async create() {
        return {
          async execute(input): Promise<JsonObject> {
            proposals++;
            const cwd = string(object(input).cwd);
            const current = object(
              JSON.parse(
                await readFile(join(cwd, 'candidate/tuning.json'), 'utf8'),
              ),
            );
            assert.match(
              await readFile(join(cwd, 'context/input.json'), 'utf8'),
              /parameterCatalog/,
            );
            assert.match(
              await readFile(join(cwd, 'context/measurements.json'), 'utf8'),
              /requestThroughput/,
            );
            return {
              proposals: [
                {
                  edits: [
                    {
                      op: 'replace',
                      path: 'tuning.json',
                      content: JSON.stringify({
                        max_num_seqs: Number(current.max_num_seqs) + 8,
                      }),
                    },
                  ],
                  reason: 'Fixture batching improvement',
                },
              ],
            };
          },
          async dispose() {},
        };
      },
    });
    try {
      await writeFile(
        join(f.root, 'prompt.md'),
        'Optimize request throughput with TTFT <= 100. Edit only tuning.json.',
      );
      const recipe = join(f.root, 'recipe.json');
      await writeFile(
        recipe,
        JSON.stringify({
          schemaVersion: 'rsi.recipe/v1',
          id: 'ssh-fixture',
          application: { plugin: 'application.inference', config: f.config },
          policy: {
            id: 'parameter.agent',
            config: { maxTrials: 2, candidatesPerRound: 1 },
          },
          bindings: {
            agent: { plugin: 'test.ssh-agent' },
            proposer: {
              plugin: 'proposer.agent',
              config: {
                agentRef: 'agent',
                prompt: './prompt.md',
                evidenceView: 'training-summary',
              },
            },
            evaluator: {
              plugin: 'test.ssh-inferencebench',
              config: {
                services: { default: {} },
                benchmark: {
                  name: 'aisbench',
                  config: { workload },
                  solver: {
                    config: { remote: { ssh: { host: 'fixture-host' } } },
                  },
                },
              },
            },
            selector: {
              plugin: 'selector.inference',
              config: {
                metric: 'requestThroughput',
                direction: 'maximize',
                constraints: [{ metric: 'ttftP90', max: 100 }],
              },
            },
          },
          budget: {
            operations: 100,
            evaluationRuns: 3,
            elapsedWallMs: 60000,
            cleanupReserveMs: 10000,
          },
        }),
      );
      const result = await runtime.manager.run(recipe, { id: 'ssh-flow' });
      assert.equal(result.status, 'succeeded');
      const output = object(result.output);
      assert.equal(output.status, 'selected');
      assert.equal(output.candidateFeasible, true);
      assert.ok(Array.isArray(output.trials));
      assert.deepEqual(
        output.trials.map((trial) => [
          object(trial).accepted,
          object(trial).candidateFeasible,
        ]),
        [
          [true, false],
          [true, true],
        ],
      );
      assert.deepEqual(measured, [8, 16, 24]);
      assert.equal(proposals, 2);
      assert.equal((await f.records('remote/launches.jsonl')).length, 3);
      const instances = await runtime.manager.facts.list('instances');
      assert.equal(instances.length, 3);
      assert.ok(instances.every((instance) => instance.status === 'released'));
      await f.released();
    } finally {
      await runtime.dispose();
    }
  },
);
