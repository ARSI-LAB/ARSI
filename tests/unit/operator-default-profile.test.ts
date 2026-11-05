import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../src/contracts/index.js';
import { adaptProfileResult } from '../../src/plugins/evaluator-operatorbench/profile-result.js';
import type { PreparedSdkRun } from '../../src/plugins/evaluator-operatorbench/sdk-configuration.js';
import type { SdkOperatorResult } from '../../src/plugins/evaluator-operatorbench/sdk-result.js';
import {
  configSchema,
  type SdkOperatorbenchConfig,
} from '../../src/plugins/evaluator-operatorbench/schema.js';
import { digest, object } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

function fixture(collection: 'Default' | 'PipeTimeline,Default') {
  const candidate = 'a'.repeat(64);
  const reference = 'b'.repeat(64);
  const protocol = {
    caseId: 'fixed',
    seeds: [42],
    warmup: 25,
    collection,
    capture: 'after-warmup-mstx-range',
  };
  const config: SdkOperatorbenchConfig = {
    mode: 'sdk',
    task: { directory: '/fixture/task' },
    protocol: {
      warmup: 5,
      repeat: 20,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels',
    },
    sdk: {
      python: '/fixture/python',
      device: 0,
      timeoutSeconds: 30,
      profiling: { enabled: false, collection },
    },
  };
  const prepared: PreparedSdkRun = {
    operation: 'profile',
    configPath: '/fixture/config.json',
    taskId: 'fixed',
    candidateSha256: candidate,
    referenceSha256: reference,
    env: {},
    contract: {
      schemaVersion: 1,
      caseId: 'fixed',
      inputs: [{ shape: [4], dtype: 'float16', contiguous: true }],
      output: {
        shape: [4],
        dtype: 'float16',
        contiguous: true,
        independent: true,
      },
      inputUnmodified: true,
    },
  };
  const profile: JsonObject = {
    status: 'completed',
    kernels: [],
    metadata: {
      collection,
      sources: {
        candidate: { sha256: candidate },
        problem: { sha256: reference },
      },
      trace:
        collection === 'Default'
          ? {
              status: 'unavailable',
              reason: 'not-requested-by-default-protocol',
            }
          : { status: 'available', artifact: 'trace.json' },
    },
  };
  const record: JsonObject = {
    executionStatus: 'completed',
    collection: { artifacts: 'complete', trajectory: 'complete' },
    solve: { finalText: candidate },
    verdict: {
      passed: null,
      details: {
        protocol: 'kernel-profile/v1',
        operation: 'profile',
        candidateSha256: candidate,
        referenceKind: 'pytorch',
        diagnosticProtocol: protocol,
        status: 'completed',
        profiling: profile,
      },
    },
  };
  const run: JsonObject = {
    status: 'completed',
    source: {
      files: [
        { path: 'data/input.py', sha256: candidate },
        { path: 'data/problem.py', sha256: reference },
        { path: 'runtime/msprof_replay.py', sha256: 'c'.repeat(64) },
      ],
    },
  };
  const base: SdkOperatorResult = {
    status: 'completed',
    cleanup: 'confirmed',
    valid: null,
    candidateMs: null,
    referenceMs: null,
    speedup: null,
    native: { exitCode: 0 },
    assessment: null,
    conditions: null,
    profile: null,
    runId: 'run',
    attemptId: 'attempt',
    diagnostics: [],
  };
  return { config, prepared, profile, record, run, base };
}

test('Default diagnostic is explicit and completes with unavailable trace', () => {
  const f = fixture('Default');
  validate(configSchema, f.config);
  const result = adaptProfileResult(
    f.base,
    f.record,
    f.run,
    f.prepared,
    f.config,
    42,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.valid, null);
  assert.equal(result.candidateMs, null);
  assert.equal(object(result.conditions?.protocol).collection, 'Default');
  assert.deepEqual(object(result.profile?.metadata).trace, {
    status: 'unavailable',
    reason: 'not-requested-by-default-protocol',
  });
});

test('diagnostics of another collection cannot satisfy the requested protocol', () => {
  const full = fixture('PipeTimeline,Default');
  const pmu = fixture('Default');
  assert.throws(
    () =>
      adaptProfileResult(
        full.base,
        pmu.record,
        pmu.run,
        full.prepared,
        full.config,
        42,
      ),
    /protocol mismatch/,
  );
  assert.throws(
    () =>
      adaptProfileResult(
        pmu.base,
        full.record,
        full.run,
        pmu.prepared,
        pmu.config,
        42,
      ),
    /protocol mismatch/,
  );
  const fullResult = adaptProfileResult(
    full.base,
    full.record,
    full.run,
    full.prepared,
    full.config,
    42,
  );
  const pmuResult = adaptProfileResult(
    pmu.base,
    pmu.record,
    pmu.run,
    pmu.prepared,
    pmu.config,
    42,
  );
  assert.notEqual(
    digest(fullResult.conditions?.protocol),
    digest(pmuResult.conditions?.protocol),
  );
});

test('Default diagnostic rejects a missing or fabricated available trace marker', () => {
  const f = fixture('Default');
  const metadata = object(f.profile.metadata);
  delete metadata.trace;
  assert.throws(
    () => adaptProfileResult(f.base, f.record, f.run, f.prepared, f.config, 42),
    /trace/i,
  );
  metadata.trace = { status: 'available', artifact: 'trace.json' };
  assert.throws(
    () => adaptProfileResult(f.base, f.record, f.run, f.prepared, f.config, 42),
    /trace/i,
  );
});

test('profiling collection rejects invalid values before execution', () => {
  const f = fixture('Default');
  assert.throws(() =>
    validate(configSchema, {
      ...f.config,
      sdk: {
        ...f.config.sdk,
        profiling: { enabled: false, collection: 'Default,PipeTimeline' },
      },
    }),
  );
});

test('legacy first-match captures cannot satisfy the post-warmup diagnostic protocol', () => {
  const f = fixture('Default');
  object(object(object(f.record.verdict).details).diagnosticProtocol).capture =
    'first-match';
  assert.throws(
    () => adaptProfileResult(f.base, f.record, f.run, f.prepared, f.config, 42),
    /protocol mismatch/,
  );
});
