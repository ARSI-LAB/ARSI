import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../../src/plugins/evaluator-operatorbench/schema.js';
import { validate } from '../../src/shared/schema.js';

test('profiling collection rejects invalid values before execution', () => {
  const config = {
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
      profiling: { enabled: false, collection: 'Default' },
    },
  };
  validate(configSchema, config);
  assert.throws(() =>
    validate(configSchema, {
      ...config,
      sdk: {
        ...config.sdk,
        profiling: { enabled: false, collection: 'Default,PipeTimeline' },
      },
    }),
  );
});
