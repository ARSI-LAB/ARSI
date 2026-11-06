import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  copyFile,
  chmod,
  readdir,
  readFile,
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Evaluator } from 'ember-evaluator';
import { prepareSdkConfiguration } from '../../src/plugins/evaluator-operatorbench/sdk.js';
import { adaptSdkResult } from '../../src/plugins/evaluator-operatorbench/result.js';
import { createOperatorbench } from '../../src/plugins/evaluator-operatorbench/service.js';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { object } from '../../src/shared/json.js';

useOperatorSdkTestEnvironment();

test('operator SDK configuration runs the actual kernel SDK with only the device worker replaced', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-kernel-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskDirectory = join(directory, 'task');
  const sourceDirectory = join(directory, 'source');
  await mkdir(taskDirectory);
  await mkdir(sourceDirectory);
  let source = '# fixture:latency=8\ndef kernel_function(x): return x\n';
  await writeFile(join(sourceDirectory, 'input.py'), source);
  await writeFile(join(taskDirectory, 'problem.py'), '# fixture reference\n');
  const worker = join(directory, 'worker.mjs');
  await copyFile(
    new URL('../fixtures/operator-sdk/worker.mjs', import.meta.url),
    worker,
  );
  await chmod(worker, 0o755);
  const config = {
    mode: 'sdk' as const,
    task: { directory: taskDirectory },
    protocol: {
      warmup: 5,
      repeat: 20,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels' as const,
    },
    sdk: {
      python: worker,
      device: 0,
      timeoutSeconds: 15,
      runTimeoutSeconds: 65,
      outputLimitBytes: 8 * 1024 * 1024,
      cleanupGraceMs: 200,
      cleanupTimeoutMs: 4000,
      profiling: { enabled: false },
    },
  };
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
  const prepared = await prepareSdkConfiguration(
    config,
    contract,
    { id: 'fixed', seed: 42 },
    {
      directory: sourceDirectory,
      sourceDigest: createHash('sha256').update(source).digest('hex'),
    },
    join(directory, 'call'),
  );
  const generated = JSON.parse(await readFile(prepared.configPath, 'utf8'));
  assert.equal(generated.run.timeoutSeconds, 65);
  assert.equal(generated.benchmark.config.outputLimitBytes, 8 * 1024 * 1024);
  assert.equal(generated.benchmark.config.cleanupGraceMs, 200);
  assert.equal(generated.benchmark.config.cleanupTimeoutMs, 4000);
  const result = await new Evaluator().run({
    configPath: prepared.configPath,
    env: { ...process.env, ...prepared.env },
  });
  assert.equal(result.kind, 'local');
  if (result.kind !== 'local') throw new Error('Expected local SDK');
  assert.equal(result.exitCode, 0, JSON.stringify(result.snapshot.records));
  assert.equal(result.snapshot.records.length, 1);
  assert.equal(result.snapshot.records[0]?.cleanupStatus, 'cleaned');
  assert.equal(result.snapshot.records[0]?.verdict?.passed, true);
  assert.equal(
    object(result.snapshot.records[0]?.verdict?.details).candidateMs,
    8,
  );
  const adapted = adaptSdkResult(result, prepared, config, 42);
  assert.equal(adapted.status, 'completed');
  assert.equal(adapted.valid, true);
  assert.equal(adapted.candidateMs, 8);
  assert.equal(adapted.referenceMs, 16);
  assert.equal(adapted.profile, null);
  const diagnostic = JSON.parse(JSON.stringify(result));
  diagnostic.snapshot.records[0].verdict = {
    passed: null,
    details: {
      protocol: 'kernel-profile/v1',
      operation: 'profile',
      candidateSha256: prepared.candidateSha256,
      referenceKind: 'pytorch',
      status: 'completed',
      cleanup: 'confirmed',
      diagnosticProtocol: {
        caseId: 'fixed',
        seeds: [42],
        warmup: 25,
        collection: 'PipeTimeline,Default',
        capture: 'after-warmup-mstx-range',
      },
      profiling: {
        schemaVersion: 1,
        status: 'completed',
        error: '',
        metadata: {
          collection: 'PipeTimeline,Default',
          trace: { status: 'available', artifact: 'trace.json' },
          sources: {
            candidate: { sha256: prepared.candidateSha256 },
            problem: { sha256: prepared.referenceSha256 },
          },
        },
        kernels: [
          { name: 'fixture', metrics: { '0': { aiv_vec_ratio: 0.5 } } },
        ],
        artifacts: [],
      },
    },
  };
  diagnostic.snapshot.records[0].scoreStatus = 'not-applicable';
  if (
    !diagnostic.snapshot.run.source.files.some(
      (file: { path: string }) => file.path === 'runtime/msprof_replay.py',
    )
  )
    diagnostic.snapshot.run.source.files.push({
      path: 'runtime/msprof_replay.py',
      sha256: 'a'.repeat(64),
    });
  const profilePrepared = { ...prepared, operation: 'profile' as const };
  const profileResult = adaptSdkResult(diagnostic, profilePrepared, config, 42);
  assert.equal(profileResult.status, 'completed');
  assert.equal(profileResult.valid, null);
  assert.equal(profileResult.candidateMs, null);
  assert.equal(profileResult.profile?.status, 'completed');
  const unavailable = structuredClone(diagnostic);
  unavailable.snapshot.records[0].verdict.details.status = 'unavailable';
  unavailable.snapshot.records[0].verdict.details.profiling.status = 'failed';
  assert.equal(
    adaptSdkResult(unavailable, profilePrepared, config, 42).status,
    'completed',
  );
  const raw = JSON.parse(JSON.stringify(result));
  raw.snapshot.records[0].verdict.details.assessment.checks.pop();
  assert.throws(() => adaptSdkResult(raw, prepared, config, 42), /checks/);
  const wrongCandidate = JSON.parse(JSON.stringify(result));
  wrongCandidate.snapshot.records[0].verdict.details.candidateSha256 =
    'b'.repeat(64);
  assert.throws(
    () => adaptSdkResult(wrongCandidate, prepared, config, 42),
    /identity/,
  );
  const unconfirmed = JSON.parse(JSON.stringify(result));
  unconfirmed.snapshot.records[0].cleanupStatus = 'unconfirmed';
  assert.equal(
    adaptSdkResult(unconfirmed, prepared, config, 42).status,
    'unknown',
  );
  const cancelled = JSON.parse(JSON.stringify(result));
  cancelled.snapshot.records[0].executionStatus = 'cancelled';
  assert.equal(
    adaptSdkResult(cancelled, prepared, config, 42).status,
    'cancelled',
  );
  const profiled = JSON.parse(JSON.stringify(result));
  profiled.snapshot.records[0].verdict.details.profiling = {
    schemaVersion: 1,
    status: 'failed',
    error: 'Fixture profiling failed',
    kernels: [],
    metadata: { upstreamCommit: 'fixture' },
    artifacts: [],
  };
  const withProfile = adaptSdkResult(profiled, prepared, config, 42);
  assert.equal(withProfile.valid, true);
  assert.equal(withProfile.candidateMs, 8);
  assert.ok(
    withProfile.diagnostics.some((d) => d.code === 'KERNEL_PROFILE_SUMMARY'),
  );

  await writeFile(join(taskDirectory, 'test.py'), '# fixture provenance\n');
  await writeFile(
    join(taskDirectory, 'task.json'),
    JSON.stringify({
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'fixture-copy',
      cases: [{ id: 'fixed', seed: 42 }],
      contract,
    }),
  );
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const recorded: JsonObject[] = [];
  let charges = 0,
    releases = 0;
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'sdk-eval',
    bindingId: 'evaluator',
    idempotencyKey: 'sdk-eval',
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
          directory: sourceDirectory,
          artifactRef: await artifacts.capture(sourceDirectory),
          sourceDigest: createHash('sha256').update(source).digest('hex'),
          entryPoint: 'kernel_function',
        });
      } finally {
        releases++;
      }
    },
  });
  const operation = await createOperatorbench(config, context);
  const input = {
    action: 'evaluate' as const,
    candidateRef: 'candidate:fixture',
    caseIds: ['fixed'],
  };
  await assert.rejects(
    operation.execute({ ...input, caseIds: ['fixed', 'other'] }, context),
    /one case/,
  );
  assert.equal(charges, 0);
  await operation.execute(input, context);
  assert.equal(
    object(object(recorded[0]!.metrics).latencyMeanMs).status,
    'available',
  );
  assert.deepEqual(object(object(recorded[0]!.metrics).latencyMeanMs).value, {
    kind: 'scalar',
    value: 8,
  });
  assert.equal(object(recorded[0]!.metrics).latencyMs, undefined);
  const provenance = await artifacts.readJson(
    String(object(recorded[0]!.provenance).artifactRef),
  );
  assert.equal(object(provenance).realNpuRuns, null);
  source = source.replace('latency=8', 'latency=4');
  await writeFile(join(sourceDirectory, 'input.py'), source);
  await operation.execute(
    input,
    context.extend({
      directory: join(directory, 'plugin-call-2'),
      callId: 'sdk-eval-2',
    }),
  );
  assert.equal(
    recorded[0]!.comparisonKey,
    recorded[1]!.comparisonKey,
    'Candidate changes must preserve fixed comparison identity',
  );
  source += '# fixture:incorrect\n';
  await writeFile(join(sourceDirectory, 'input.py'), source);
  await operation.execute(
    input,
    context.extend({
      directory: join(directory, 'plugin-call-3'),
      callId: 'sdk-eval-3',
    }),
  );
  assert.deepEqual(object(object(recorded[2]!.metrics).candidateValid).value, {
    kind: 'scalar',
    value: 0,
  });
  assert.equal(
    object(object(recorded[2]!.metrics).latencyMeanMs).status,
    'unavailable',
  );
  source += '# fixture:infrastructure\n';
  await writeFile(join(sourceDirectory, 'input.py'), source);
  await assert.rejects(
    operation.execute(
      input,
      context.extend({
        directory: join(directory, 'plugin-call-4'),
        callId: 'sdk-eval-4',
      }),
    ),
    /assessment failed/,
  );
  assert.equal(recorded[3]!.status, 'failed');
  assert.equal(
    object(object(recorded[3]!.metrics).candidateValid).status,
    'unavailable',
  );
  assert.equal(charges, 4);
  assert.equal(releases, 4);
  source = '# fixture:wait\ndef kernel_function(x): return x\n';
  await writeFile(join(sourceDirectory, 'input.py'), source);
  const controller = new AbortController();
  const cancelDirectory = join(directory, 'cancel-call');
  const pending = operation
    .execute(
      input,
      context.extend({
        signal: controller.signal,
        directory: cancelDirectory,
        callId: 'sdk-cancel',
      }),
    )
    .then(
      () => null,
      (error) => error,
    );
  try {
    const deadline = Date.now() + 10000;
    let started = false;
    while (!started && Date.now() < deadline) {
      const files = await readdir(cancelDirectory, { recursive: true }).catch(
        (error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      started = files.some((file) => file.endsWith('.started'));
      if (!started) await delay(10);
    }
    assert.ok(
      started,
      'Cancellation must interrupt an actually started device worker',
    );
  } finally {
    controller.abort();
  }
  assert.match(String(await pending), /assessment cancelled/);
  assert.equal(recorded[4]!.status, 'cancelled');
  const cancelledProvenance = object(
    await artifacts.readJson(
      String(object(recorded[4]!.provenance).artifactRef),
    ),
  );
  assert.equal(cancelledProvenance.cleanup, 'confirmed');
  assert.equal(charges, 5);
  assert.equal(releases, 5);
  source = '# fixture:latency=8\ndef kernel_function(x): return x\n';
  await writeFile(join(sourceDirectory, 'input.py'), source);
  const msprof = join(directory, 'msprof');
  const pidFile = join(directory, 'profile-child.pid');
  await writeFile(
    msprof,
    `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);\n`,
  );
  await chmod(msprof, 0o755);
  const profileOperation = await createOperatorbench(
    {
      ...config,
      sdk: {
        ...config.sdk,
        profiling: {
          enabled: true,
          cacheEnabled: false,
          msprofBin: msprof,
          maxAttempts: 1,
          attemptTimeoutSeconds: 5,
        },
      },
    },
    context,
  );
  const profileController = new AbortController();
  const profiling = profileOperation
    .execute(
      input,
      context.extend({
        signal: profileController.signal,
        directory: join(directory, 'profile-cancel-call'),
        callId: 'sdk-profile-cancel',
      }),
    )
    .then(
      () => null,
      (error) => error,
    );
  let profileChild: number | undefined;
  t.after(() => {
    if (profileChild) {
      try {
        process.kill(profileChild, 'SIGKILL');
      } catch {}
    }
  });
  try {
    for (let count = 0; count < 200; count++) {
      try {
        profileChild = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        await delay(10);
      }
    }
    assert.ok(profileChild, 'SDK profiling must have started a replay child');
  } finally {
    profileController.abort();
  }
  assert.match(String(await profiling), /assessment cancelled/);
  let running = true;
  for (let count = 0; count < 50 && running; count++) {
    try {
      process.kill(profileChild!, 0);
      if (process.platform === 'linux')
        running = !(await readFile(`/proc/${profileChild}/stat`, 'utf8'))
          .split(') ')[1]
          ?.startsWith('Z');
    } catch {
      running = false;
    }
    if (running) await delay(10);
  }
  assert.equal(
    running,
    false,
    'Confirmed SDK cleanup must leave no running profiler replay child',
  );
  assert.equal(recorded[5]!.status, 'cancelled');
  const profileProvenance = object(
    await artifacts.readJson(
      String(object(recorded[5]!.provenance).artifactRef),
    ),
  );
  assert.equal(profileProvenance.cleanup, 'confirmed');
  assert.equal(charges, 6);
  assert.equal(releases, 6);
  await profileOperation.dispose();
  await operation.dispose();
});
