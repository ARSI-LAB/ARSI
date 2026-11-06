import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeContext } from '../../src/contracts/index.js';
import { createOperatorbench } from '../../src/plugins/evaluator-operatorbench/service.js';
import { configSchema } from '../../src/plugins/evaluator-operatorbench/schema.js';
import { validate } from '../../src/shared/schema.js';

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

test('operatorbench rejects mock configuration before reading task or fixture files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-operator-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    createOperatorbench(
      {
        mode: 'mock',
        task: { directory: join(directory, 'task') },
        protocol: {
          warmup: 2,
          repeat: 3,
          timingScope: 'all-device-work',
          outputAllocation: 'excluded',
        },
        fixtures: join(directory, 'fixtures.json'),
      },
      new RuntimeContext(),
    ),
    /operatorbench config:.*mode.*constant/s,
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

test('operatorbench accepts configured timing counts and SDK resource controls above former ceilings', () => {
  validate(
    configSchema,
    {
      ...sdkConfig,
      protocol: { ...sdkConfig.protocol, warmup: 10001, repeat: 4097 },
      sdk: {
        ...sdkConfig.sdk,
        runTimeoutSeconds: 60,
        outputLimitBytes: 4 * 1024 * 1024,
        cleanupGraceMs: 500,
        cleanupTimeoutMs: 5000,
        profiling: { enabled: false, cacheMaxEntries: 1024, retryDelayMs: 0 },
      },
    },
    'operatorbench config',
  );
});
