import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { operatorbenchContract } from '../../src/contracts/plugin-types/operatorbench.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { readProfileAssessment } from '../../src/plugins/evaluator-operatorbench/conditions.js';
import { parseKernelExecution } from '../../src/plugins/application-kernel/schema.js';
import { recordSdkMeasurement } from '../../src/plugins/evaluator-operatorbench/measurement.js';
import { validate } from '../../src/shared/schema.js';
import { object } from '../../src/shared/json.js';

useOperatorSdkTestEnvironment();

test('operatorbench requires explicit purpose and an assessment for diagnostic calls', () => {
  validate(operatorbenchContract.input_schema, {
    action: 'evaluate',
    candidateRef: 'c',
    caseIds: ['fixed'],
  });
  validate(operatorbenchContract.input_schema, {
    action: 'profile',
    candidateRef: 'c',
    caseIds: ['fixed'],
    assessmentMeasurementRef: 'm',
  });
  assert.throws(() =>
    validate(operatorbenchContract.input_schema, {
      candidateRef: 'c',
      caseIds: ['fixed'],
    }),
  );
  assert.throws(() =>
    validate(operatorbenchContract.input_schema, {
      action: 'profile',
      candidateRef: 'c',
      caseIds: ['fixed'],
    }),
  );
});

for (const sdkStatus of ['completed', 'cancelled', 'unknown'] as const)
  test(`diagnostic measurements preserve their purpose and never expose selection metrics (${sdkStatus})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'rsi-profile-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifacts(join(dir, 'artifacts'));
    let recorded: JsonObject | undefined;
    const context = new RuntimeContext().extend({
      experimentId: 'exp',
      callId: 'call',
      artifacts,
      async recordMeasurement(value: JsonObject) {
        recorded = value;
        return 'measurement';
      },
    });
    await recordSdkMeasurement(
      {
        status: sdkStatus,
        cleanup: sdkStatus === 'unknown' ? 'unknown' : 'confirmed',
        valid: null,
        candidateMs: null,
        referenceMs: null,
        speedup: null,
        native: {},
        assessment: null,
        conditions: sdkStatus === 'completed' ? { operation: 'profile' } : null,
        profile: { status: 'completed', kernels: [], metadata: {} },
        runId: 'run',
        attemptId: 'attempt',
        diagnostics: [],
      },
      'candidate',
      'fixed',
      parseKernelExecution({
        kind: 'kernel-source',
        format: 'triton-ascend',
        entryPoint: 'kernel_function',
        sourcePath: 'input.py',
        directory: dir,
        sourceDigest: 'a'.repeat(64),
        artifactRef: 'source',
      }),
      {
        mode: 'sdk',
        taskDigest: 'b'.repeat(64),
        adapterDigest: 'c'.repeat(64),
        sdkBuildDigest: 'd'.repeat(64),
        evaluation: { operation: 'profile' },
      },
      [],
      context,
      'profile',
    );
    assert.ok(recorded);
    assert.deepEqual(recorded.metrics, {});
    assert.equal(
      recorded.status,
      sdkStatus === 'completed' ? 'succeeded' : sdkStatus,
    );
    const profile = object(
      await artifacts.readJson(object(recorded.profile).artifactRef as string),
    );
    assert.equal(profile.operation, 'profile');
    assert.equal(object(profile.profile).status, 'completed');
    if (sdkStatus === 'completed')
      assert.notEqual(recorded.comparisonKey, null);
  });

test('diagnostic calls reject assessments of another source or experiment', async () => {
  const context = new RuntimeContext().extend({
    experimentId: 'exp',
    async readMeasurement() {
      return { experimentId: 'another', candidateRef: 'candidate' };
    },
  });
  await assert.rejects(
    readProfileAssessment(
      'm',
      'candidate',
      {
        taskDigest: 't',
        sdkBuildDigest: 's',
        adapterDigest: 'a',
        caseId: 'fixed',
        seed: 42,
      },
      context,
    ),
    /experiment|assessment/,
  );
});

test('a passing assessment cannot certify a different case or seed of the same task', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-profile-case-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(join(dir, 'artifacts'));
  const conditionsRef = await artifacts.putJson({
    taskDigest: 't',
    sdkBuildDigest: 's',
    adapterDigest: 'a',
    evaluation: { contract: { caseId: 'case-a' }, protocol: { seeds: [42] } },
  });
  const provenanceRef = await artifacts.putJson({
    cleanup: 'confirmed',
    sourceDigest: 'source',
  });
  const context = new RuntimeContext().extend({
    experimentId: 'exp',
    artifacts,
    async readMeasurement() {
      return {
        experimentId: 'exp',
        candidateRef: 'candidate',
        status: 'succeeded',
        coverage: 'complete',
        comparisonKey: 'key',
        metrics: { candidateValid: { value: { value: 1 } } },
        conditions: { artifactRef: conditionsRef },
        provenance: { artifactRef: provenanceRef },
      };
    },
  });
  const identity = {
    taskDigest: 't',
    sdkBuildDigest: 's',
    adapterDigest: 'a',
    caseId: 'case-a',
    seed: 42,
  };
  await readProfileAssessment('m', 'candidate', identity, context);
  await assert.rejects(
    readProfileAssessment(
      'm',
      'candidate',
      { ...identity, caseId: 'case-b' },
      context,
    ),
    /case|seed/,
  );
  await assert.rejects(
    readProfileAssessment('m', 'candidate', { ...identity, seed: 0 }, context),
    /case|seed/,
  );
});

test('a rebuilt SDK cannot profile an assessment from the previous build', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-profile-sdk-rebuild-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  // Isolate both the adapter's module resolution and the SDK distribution so
  // this test never changes the installed package used by other tests.
  await cp(join(repository, 'src'), join(directory, 'src'), {
    recursive: true,
  });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  const modules = join(directory, 'node_modules');
  await mkdir(modules);
  for (const name of await readdir(join(repository, 'node_modules'))) {
    const installed = join(repository, 'node_modules', name);
    const isolated = join(modules, name);
    if (name === 'ember-evaluator')
      await cp(await realpath(installed), isolated, { recursive: true });
    else await symlink(installed, isolated, 'dir');
  }
  const {
    createOperatorbench,
  }: typeof import('../../src/plugins/evaluator-operatorbench/service.js') =
    await import(
      pathToFileURL(
        join(directory, 'src/plugins/evaluator-operatorbench/service.ts'),
      ).href
    );
  const taskDirectory = join(directory, 'task');
  const sourceDirectory = join(directory, 'source');
  await mkdir(taskDirectory);
  await mkdir(sourceDirectory);
  const source = '# fixture:latency=8\ndef kernel_function(x): return x\n';
  const sha256 = (value: string | Uint8Array): string =>
    createHash('sha256').update(value).digest('hex');
  await writeFile(join(sourceDirectory, 'input.py'), source);
  await writeFile(join(taskDirectory, 'problem.py'), '# fixture reference\n');
  await writeFile(join(taskDirectory, 'test.py'), '# fixture provenance\n');
  await writeFile(
    join(taskDirectory, 'task.json'),
    JSON.stringify({
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'fixture',
      cases: [{ id: 'fixed', seed: 42 }],
      contract: {
        inputs: [{ shape: [4], dtype: 'float16' }],
        output: {
          shape: [4],
          dtype: 'float16',
          contiguous: true,
          independent: true,
        },
        inputUnmodified: true,
      },
    }),
  );
  const worker = join(directory, 'worker.mjs');
  const msprof = join(directory, 'msprof.mjs');
  for (const [name, destination] of [
    ['worker.mjs', worker],
    ['msprof.mjs', msprof],
  ]) {
    await copyFile(
      join(repository, 'tests/fixtures/operator-sdk', name!),
      destination!,
    );
    await chmod(destination!, 0o755);
  }
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const measurements = new Map<string, JsonObject>();
  let evaluationRuns = 0;
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'evaluate',
    directory: join(directory, 'evaluate'),
    artifacts,
    signal: new AbortController().signal,
    async charge(metric: string, amount: number) {
      assert.equal(metric, 'evaluationRuns');
      evaluationRuns += amount;
    },
    async readMeasurement(ref: string) {
      const measurement = measurements.get(ref);
      assert.ok(measurement);
      return measurement;
    },
    async recordMeasurement(measurement: JsonObject) {
      const ref = `measurement:${measurements.size}`;
      measurements.set(ref, measurement);
      return ref;
    },
    async withInstance(_ref, _capability, use) {
      return use({
        kind: 'kernel-source',
        format: 'triton-ascend',
        entryPoint: 'kernel_function',
        sourcePath: 'input.py',
        directory: sourceDirectory,
        sourceDigest: sha256(source),
        artifactRef: await artifacts.capture(sourceDirectory),
      });
    },
  });
  const operation = await createOperatorbench(
    {
      task: { directory: taskDirectory },
      benchmark: {
        name: 'kernel',
        config: {
          warmup: 5,
          repeat: 20,
          rtol: 0,
          atol: 0,
          python: worker,
          device: 0,
          timeoutSeconds: 15,
          profiling: {
            enabled: false,
            msprofBin: msprof,
            cacheEnabled: false,
            maxAttempts: 1,
            attemptTimeoutSeconds: 5,
          },
        },
      },
      run: { onError: 'abort', timeoutSeconds: 45 },
    },
    context,
  );
  t.after(() => operation.dispose());
  const assessment = await operation.execute(
    { action: 'evaluate', candidateRef: 'candidate', caseIds: ['fixed'] },
    context,
  );
  const distribution = join(modules, 'ember-evaluator/dist');
  const replay = 'adapters/kernel/msprof_replay.py';
  await appendFile(
    join(distribution, replay),
    '\n# A rebuilt diagnostic runtime after the precision assessment\n',
  );
  // Keep a valid package inventory: an ordinary corrupt asset is already
  // rejected by SDK bootstrap and would not reproduce this identity gap.
  const provenancePath = join(distribution, 'package-provenance.json');
  const provenance = object(JSON.parse(await readFile(provenancePath, 'utf8')));
  const files = object(provenance.files);
  files[replay] =
    `sha256:${sha256(await readFile(join(distribution, replay)))}`;
  provenance.digest = `sha256:${sha256(
    JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', files }),
  )}`;
  await writeFile(provenancePath, JSON.stringify(provenance));
  await assert.rejects(
    operation.execute(
      {
        action: 'profile',
        candidateRef: 'candidate',
        caseIds: ['fixed'],
        assessmentMeasurementRef: assessment.measurementRef,
      },
      context.extend({
        callId: 'profile',
        directory: join(directory, 'profile'),
      }),
    ),
    /SDK.*(?:build|identity).*changed|changed.*SDK|SDK.*mismatch/i,
  );
  assert.equal(
    evaluationRuns,
    1,
    'A changed build must be rejected before profiling',
  );
});
