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
import {
  Evaluator,
  parseKernelContract,
  type EvaluatorRunOptions,
  type EvaluationResult,
} from 'ember-evaluator';
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
  const sourcePath = 'ops/candidate.py';
  await mkdir(join(sourceDirectory, 'ops'), { recursive: true });
  let source = '# fixture:latency=8\ndef kernel_function(x): return x\n';
  await writeFile(join(sourceDirectory, sourcePath), source);
  await writeFile(join(taskDirectory, 'problem.py'), '# fixture reference\n');
  const worker = join(directory, 'worker.mjs');
  await copyFile(
    new URL('../fixtures/operator-sdk/worker.mjs', import.meta.url),
    worker,
  );
  await chmod(worker, 0o755);
  const config = {
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
        outputLimitBytes: 8 * 1024 * 1024,
        cleanupGraceMs: 200,
        cleanupTimeoutMs: 4000,
        profiling: { enabled: false },
      },
    },
    reporter: 'markdown',
    run: { timeoutSeconds: 45 },
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
  await writeFile(join(taskDirectory, 'test.py'), '# fixture provenance\n');
  await writeFile(
    join(taskDirectory, 'task.json'),
    JSON.stringify({
      schemaVersion: 'rsi.kernel-task/v1',
      id: 'fixture-copy',
      cases: [
        { id: 'fixed', seed: 42 },
        { id: 'alternate', seed: 7 },
      ],
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
    async applicationMetadata() {
      return {
        target: {
          schemaVersion: 'rsi.target/v1',
          id: 'kernel',
          entries: [
            {
              path: sourcePath,
              kind: 'file',
              description: 'entry',
              changes: ['modify'],
            },
          ],
        },
      };
    },
    withInstance: async (_ref, capability, use) => {
      assert.equal(capability, 'kernel-source');
      try {
        return await use({
          kind: 'kernel-source',
          format: 'triton-ascend',
          directory: sourceDirectory,
          sourcePath,
          artifactRef: await artifacts.capture(sourceDirectory),
          sourceFiles: [
            {
              path: sourcePath,
              sha256: createHash('sha256').update(source).digest('hex'),
            },
          ],
          entryPoint: 'kernel_function',
        });
      } finally {
        releases++;
      }
    },
  });
  const calls: { options: EvaluatorRunOptions; result: EvaluationResult }[] =
    [];
  const operation = await createOperatorbench(
    config,
    context,
    async (options) => {
      const result = await new Evaluator().run(options);
      calls.push({ options, result });
      return result;
    },
  );
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
  assert.equal(calls.length, 1);
  const { options, result } = calls[0]!;
  assert.equal(options.signal, context.signal);
  const saved = JSON.parse(await readFile(options.configPath, 'utf8'));
  assert.deepEqual(saved.reporter, { name: 'markdown', config: {} });
  assert.equal(saved.run.timeoutSeconds, 45);
  assert.equal(saved.benchmark.config.outputLimitBytes, 8 * 1024 * 1024);
  assert.equal(saved.benchmark.config.cleanupGraceMs, 200);
  assert.equal(saved.benchmark.config.cleanupTimeoutMs, 4000);
  assert.deepEqual(saved.run.taskIds, ['fixed']);
  assert.deepEqual(saved.benchmark.config.seeds, [42]);
  assert.equal(saved.task, undefined);
  assert.equal(config.benchmark.config.profiling.enabled, false);
  const manifest = JSON.parse(
    await readFile(saved.benchmark.config.manifest, 'utf8'),
  );
  const candidateSha256 = createHash('sha256').update(source).digest('hex');
  const prepared = {
    sourceInventory: {
      entryFile: sourcePath,
      files: [{ path: sourcePath, sha256: candidateSha256 }],
      mutablePaths: [sourcePath],
    },
    operation: input.action,
    taskId: 'fixed',
    seed: 42,
    contract: parseKernelContract(manifest.tasks[0].contract),
    candidateSha256,
    referenceSha256: createHash('sha256')
      .update('# fixture reference\n')
      .digest('hex'),
  };
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
  const adapted = adaptSdkResult(result, prepared);
  assert.equal(adapted.status, 'completed');
  assert.equal(adapted.valid, true);
  assert.equal(adapted.candidateMs, 8);
  assert.equal(adapted.referenceMs, 16);
  assert.equal(adapted.profile, null);
  const changedSingle = JSON.parse(JSON.stringify(result));
  changedSingle.snapshot.run.source.files.find(
    (file: { path: string }) => file.path === `data/candidate/${sourcePath}`,
  ).sha256 = '0'.repeat(64);
  assert.throws(
    () => adaptSdkResult(changedSingle, prepared),
    /inventory.*identity/i,
  );
  const unicodeFiles = [
    { path: sourcePath, sha256: prepared.candidateSha256 },
    { path: '\u00e9.py', sha256: 'a'.repeat(64) },
    { path: 'e\u0301.py', sha256: 'b'.repeat(64) },
  ];
  const unicodeNative = JSON.parse(JSON.stringify(result));
  unicodeNative.snapshot.run.source.files =
    unicodeNative.snapshot.run.source.files
      .filter(
        (file: { path: string }) =>
          file.path !== `data/candidate/${sourcePath}`,
      )
      .concat(
        [...unicodeFiles]
          .reverse()
          .map((file) => ({ ...file, path: `data/candidate/${file.path}` })),
      );
  assert.equal(
    adaptSdkResult(unicodeNative, {
      ...prepared,
      sourceInventory: {
        entryFile: sourcePath,
        files: unicodeFiles,
        mutablePaths: [],
      },
    }).status,
    'completed',
  );
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
            problem: {
              sha256: createHash('sha256')
                .update('# fixture reference\n')
                .digest('hex'),
            },
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
  const profileResult = adaptSdkResult(diagnostic, profilePrepared);
  assert.equal(profileResult.status, 'completed');
  assert.equal(profileResult.valid, null);
  assert.equal(profileResult.candidateMs, null);
  assert.equal(profileResult.profile?.status, 'completed');
  for (const [native, plan] of [
    [result, prepared],
    [diagnostic, profilePrepared],
  ] as const) {
    const changed = JSON.parse(JSON.stringify(native));
    const files: { path: string; sha256: string }[] =
      changed.snapshot.run.source.files;
    const reference = files.find((file) => file.path === 'data/problem.py');
    assert.ok(reference);
    const rejectReference = () =>
      assert.throws(
        () => adaptSdkResult(changed, plan),
        /reference.*identity/i,
      );
    files.push({ ...reference });
    rejectReference();
    files.pop();
    reference.sha256 = '0'.repeat(64);
    rejectReference();
    files.splice(files.indexOf(reference), 1);
    rejectReference();
  }
  const unavailable = structuredClone(diagnostic);
  unavailable.snapshot.records[0].verdict.details.status = 'unavailable';
  unavailable.snapshot.records[0].verdict.details.profiling.status = 'failed';
  assert.equal(
    adaptSdkResult(unavailable, profilePrepared).status,
    'completed',
  );
  const raw = JSON.parse(JSON.stringify(result));
  raw.snapshot.records[0].verdict.details.assessment.checks.pop();
  assert.throws(() => adaptSdkResult(raw, prepared), /checks/);
  const wrongCandidate = JSON.parse(JSON.stringify(result));
  wrongCandidate.snapshot.records[0].verdict.details.candidateSha256 =
    'b'.repeat(64);
  assert.throws(() => adaptSdkResult(wrongCandidate, prepared), /identity/);
  const unconfirmed = JSON.parse(JSON.stringify(result));
  unconfirmed.snapshot.records[0].cleanupStatus = 'unconfirmed';
  assert.equal(adaptSdkResult(unconfirmed, prepared).status, 'unknown');
  const cancelled = JSON.parse(JSON.stringify(result));
  cancelled.snapshot.records[0].executionStatus = 'cancelled';
  assert.equal(adaptSdkResult(cancelled, prepared).status, 'cancelled');
  const profiled = JSON.parse(JSON.stringify(result));
  profiled.snapshot.records[0].verdict.details.profiling = {
    schemaVersion: 1,
    status: 'failed',
    error: 'Fixture profiling failed',
    kernels: [],
    metadata: { upstreamCommit: 'fixture' },
    artifacts: [],
  };
  const withProfile = adaptSdkResult(profiled, prepared);
  assert.equal(withProfile.valid, true);
  assert.equal(withProfile.candidateMs, 8);
  assert.ok(
    withProfile.diagnostics.some((d) => d.code === 'KERNEL_PROFILE_SUMMARY'),
  );

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
  await writeFile(join(sourceDirectory, sourcePath), source);
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
  await writeFile(join(sourceDirectory, sourcePath), source);
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
  await writeFile(join(sourceDirectory, sourcePath), source);
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
  await writeFile(join(sourceDirectory, sourcePath), source);
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
  await writeFile(join(sourceDirectory, sourcePath), source);
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
      benchmark: {
        ...config.benchmark,
        config: {
          ...config.benchmark.config,
          profiling: {
            enabled: true,
            cacheEnabled: false,
            msprofBin: msprof,
            maxAttempts: 1,
            attemptTimeoutSeconds: 5,
          },
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
  const alternateDirectory = join(directory, 'alternate-case');
  await assert.rejects(
    operation.execute(
      { ...input, caseIds: ['alternate'] },
      context.extend({
        directory: alternateDirectory,
        charge: async () => {
          throw new Error('Stop before SDK execution');
        },
      }),
    ),
    /Stop before SDK execution/,
  );
  const alternate = JSON.parse(
    await readFile(join(alternateDirectory, 'sdk-config.json'), 'utf8'),
  );
  assert.deepEqual(alternate.run.taskIds, ['alternate']);
  assert.deepEqual(alternate.benchmark.config.seeds, [7]);
  assert.equal(
    alternate.benchmark.config.manifest,
    join(alternateDirectory, 'sdk-input', 'manifest.json'),
  );
  assert.equal(
    alternate.store.config.runIndexDirectory,
    join(alternateDirectory, 'sdk-index'),
  );
  assert.equal(
    alternate.output.directory,
    join(alternateDirectory, 'sdk-output'),
  );
  const errors: unknown[] = [];
  const invalid = await createOperatorbench(
    {
      ...config,
      benchmark: {
        ...config.benchmark,
        config: {
          ...config.benchmark.config,
          profiling: { collection: 'Default,PipeTimeline' },
        },
      },
    },
    context,
    async (options) => {
      try {
        return await new Evaluator().run(options);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  );
  await assert.rejects(
    invalid.execute(
      input,
      context.extend({
        callId: 'invalid-profile',
        directory: join(directory, 'invalid-profile'),
      }),
    ),
    /assessment unknown/,
  );
  assert.match(String(errors[0]), /profiling.collection/);
  const frozenDirectory = join(directory, 'frozen-reference');
  await operation.execute(
    input,
    context.extend({
      directory: frozenDirectory,
      withInstance: async (ref, capability, use) => {
        await writeFile(
          join(taskDirectory, 'problem.py'),
          '# replaced reference\n',
        );
        return context.withInstance(ref, capability, use);
      },
    }),
  );
  assert.equal(
    await readFile(join(frozenDirectory, 'sdk-input/problem.py'), 'utf8'),
    '# fixture reference\n',
  );
  await writeFile(join(taskDirectory, 'problem.py'), '# fixture reference\n');
  const readonlyMeasurements: JsonObject[] = [];
  for (let version = 0; version < 2; version++) {
    source = `# fixture:latency=8\n# fixed ${version}\ndef kernel_function(x): return x\n`;
    await writeFile(join(sourceDirectory, sourcePath), source);
    await operation.execute(
      input,
      context.extend({
        directory: join(directory, `readonly-single-${version}`),
        callId: `readonly-single-${version}`,
        async applicationMetadata() {
          return {
            target: {
              schemaVersion: 'rsi.target/v1',
              id: 'readonly-entry',
              entries: [
                {
                  path: sourcePath,
                  kind: 'file',
                  description: 'fixed entry',
                  changes: ['modify'],
                },
              ],
              protected: [sourcePath],
            },
          };
        },
        async recordMeasurement(value) {
          readonlyMeasurements.push(value);
          return `readonly:${version}`;
        },
      }),
    );
  }
  const [firstReadonly, secondReadonly] = readonlyMeasurements;
  assert.ok(firstReadonly && secondReadonly);
  assert.notEqual(
    firstReadonly.comparisonKey,
    secondReadonly.comparisonKey,
    'Explicit readonly single entries must contribute their locked bytes',
  );
  await invalid.dispose();
  await profileOperation.dispose();
  await operation.dispose();
});
