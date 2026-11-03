import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOptunaConfig,
  validateParameters,
} from '../../src/plugins/proposer-optuna/schema.js';
import { runOptunaWorker } from '../../src/plugins/proposer-optuna/worker.js';
import { object } from '../../src/shared/json.js';

test('real Optuna float samples pass TypeScript step validation', async () => {
  const config = parseOptunaConfig({
    path: 'tuning.json',
    python: { executable: process.env.RSI_OPTUNA_PYTHON ?? 'python3' },
    sampler: { type: 'tpe', seed: 42 },
    searchSpace: [
      { name: 'x', distribution: 'float', low: 0.1, high: 0.9, step: 1e-9 },
    ],
  });
  const response = await runOptunaWorker(
    config,
    {
      action: 'suggest',
      sampler: object(config.sampler),
      constraintHandling: config.constraintHandling,
      searchSpace: config.searchSpace,
      history: [],
    },
    new AbortController().signal,
  );
  assert.doesNotThrow(() =>
    validateParameters(object(response.parameters), config.searchSpace),
  );
});
