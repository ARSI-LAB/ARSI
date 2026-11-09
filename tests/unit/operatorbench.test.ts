import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { createOperatorbench } from '../../src/plugins/evaluator-operatorbench/service.js';
import { configSchema } from '../../src/plugins/evaluator-operatorbench/schema.js';
import { validate } from '../../src/shared/schema.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { object } from '../../src/shared/json.js';

const sdkConfig = {
  mode: 'sdk' as const,
  task: { directory: '/missing-operator-task' },
  protocol: {
    warmup: 5,
    repeat: 20,
    rtol: 0,
    atol: 0,
    timingScope: 'all-device-kernels' as const,
  },
  sdk: {
    python: '/missing-operator-python',
    device: 0,
    timeoutSeconds: 15,
    profiling: { enabled: false },
  },
};

const mockConfig = {
  mode: 'mock' as const,
  task: { directory: '/missing-operator-task' },
  protocol: {
    warmup: 2,
    repeat: 3,
    timingScope: 'all-device-work' as const,
    outputAllocation: 'excluded' as const,
  },
  fixtures: '/missing-operator-fixtures.json',
};

test('operatorbench accepts mock mode and rejects sdk-only keys in it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-operator-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A structurally valid mock config passes Schema and proceeds to task
  // loading; the missing task directory is a task error, not a config error.
  await assert.rejects(
    createOperatorbench(
      { ...mockConfig, task: { directory: join(directory, 'task') } },
      new RuntimeContext(),
    ),
    /ENOENT/,
  );
  assert.throws(
    () =>
      validate(
        configSchema,
        {
          ...mockConfig,
          sdk: {
            python: 'python3',
            device: 0,
            timeoutSeconds: 1,
            profiling: { enabled: false },
          },
        },
        'operatorbench config',
      ),
    /additional properties/,
  );
});

test('operatorbench SDK configuration accepts no fixture input', () => {
  validate(configSchema, sdkConfig, 'operatorbench config');
  assert.throws(
    () =>
      validate(
        configSchema,
        { ...sdkConfig, fixtures: '/missing-operator-fixtures.json' },
        'operatorbench config',
      ),
    /additional properties/,
  );
});

test('a precheck-rejected acquire records a failed measurement and resolves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-operator-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskDirectory = join(directory, 'task');
  await mkdir(taskDirectory);
  await writeFile(join(taskDirectory, 'problem.py'), '# fixture reference\n');
  await writeFile(join(taskDirectory, 'test.py'), '# fixture provenance\n');
  const contract = {
    inputs: [{ shape: [4], dtype: 'float16' }],
    output: {
      shape: [4],
      dtype: 'float16',
      contiguous: true,
      independent: true,
    },
    inputUnmodified: true,
  };
  await writeFile(
    join(taskDirectory, 'task.json'),
    JSON.stringify({
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'fixture-reject',
      cases: [{ id: 'fixed', seed: 42 }],
      contract,
    }),
  );
  const config = {
    mode: 'sdk' as const,
    task: { directory: taskDirectory },
    protocol: {
      warmup: 1,
      repeat: 2,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels' as const,
    },
    sdk: {
      python: '/missing-operator-python',
      device: 0,
      timeoutSeconds: 15,
      profiling: { enabled: false },
    },
  };
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const recorded: JsonObject[] = [];
  let charges = 0,
    releases = 0;
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'reject-eval',
    bindingId: 'evaluator',
    idempotencyKey: 'reject-eval',
    directory: join(directory, 'plugin-call'),
    rootDirectory: directory,
    dataDirectory: directory,
    artifacts,
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
    charge: async (metric, amount) => {
      assert.equal(metric, 'evaluationRuns');
      charges += amount;
    },
    recordMeasurement: async (value) => {
      recorded.push(value);
      return `measurement:${recorded.length}`;
    },
    withInstance: async (_ref, capability, use) => {
      assert.equal(capability, 'kernel-source');
      try {
        return await use({
          kind: 'kernel-source',
          format: 'triton-ascend',
          directory: join(directory, 'source'),
          artifactRef: 'artifact:fixture',
          sourceDigest: 'a'.repeat(64),
          entryPoint: 'kernel_function',
          resources: { verified: false },
          rejection: {
            message: 'fixture precheck failure',
            logPath: join(directory, 'precheck.log'),
          },
        });
      } finally {
        releases++;
      }
    },
  });
  const operation = await createOperatorbench(config, context);
  const outcome = await operation.execute(
    {
      action: 'evaluate',
      candidateRef: 'candidate:fixture',
      caseIds: ['fixed'],
    },
    context,
  );
  assert.ok(outcome.action === 'evaluate');
  assert.equal(outcome.status, 'failed');
  assert.equal(charges, 1);
  assert.equal(releases, 1);
  assert.equal(recorded.length, 1);
  const measurement = recorded[0]!;
  assert.equal(measurement.status, 'failed');
  assert.equal(measurement.coverage, 'none');
  assert.equal(measurement.comparisonKey, null);
  const metrics = object(measurement.metrics);
  for (const metric of ['candidateValid', 'latencyMs', 'checksum_match'])
    assert.equal(object(metrics[metric]!).status, 'unavailable', metric);
  const provenance = object(
    await artifacts.readJson(
      String(object(measurement.provenance).artifactRef),
    ),
  );
  assert.equal(provenance.sourceDigest, null);
  assert.equal(provenance.cleanup, 'unknown');
  const diagnostics = object(
    await artifacts.readJson(String(measurement.diagnosticsRef)),
  );
  assert.match(
    String(diagnostics.message),
    /^Kernel candidate precheck rejected: fixture precheck failure; log: /,
  );
  const evidenceIndex = object(
    await artifacts.readJson(String(measurement.evidenceIndexRef)),
  );
  const casesDigestEntry = (evidenceIndex.entries as JsonObject[]).find(
    (entry) => entry.id === 'cases-digest',
  )!;
  const fileTree = object(
    await artifacts.readJson(String(casesDigestEntry.artifactRef)),
  );
  const casesDigest = JSON.parse(
    Buffer.from(
      String(object((fileTree.files as JsonObject[])[0]!).base64),
      'base64',
    ).toString('utf8'),
  );
  assert.equal(casesDigest.allCompleted, false);
  assert.deepEqual(casesDigest.cases[0].id, 'fixed');
  assert.match(
    String(casesDigest.cases[0].diagnostics[0]),
    /precheck rejected/,
  );
  await operation.dispose();
});
