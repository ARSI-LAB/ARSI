import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sdkDoctor } from '../../src/plugins/shared/evaluator-adapter/doctor-sdk.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-sdk-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'evaluator.json');
  const networkConfigPath = join(root, 'network.yaml');
  await writeFile(networkConfigPath, '{}\n');
  await writeFile(
    configPath,
    JSON.stringify({
      benchmark: { name: 'gsm8k', config: { localPath: './data' } },
      services: {
        default: {
          model: 'fixture',
          base_url: 'https://fixture.invalid',
          api_key: '${RSI_DOCTOR_LOCAL_AUTH}',
        },
      },
      environment: 'local',
    }),
  );
  const options = {
    configPath,
    networkConfigPath,
    env: { RSI_DOCTOR_LOCAL_AUTH: 'fixture-only' },
    signal: new AbortController().signal,
  };
  return { root, options };
}

test('native doctor uses the supplied environment and returns per-check results without a model request', async (t) => {
  const { root, options } = await fixture(t);
  const failed = await sdkDoctor(options);
  assert.equal(failed.network.configPath, options.networkConfigPath);
  assert.equal(
    failed.checks.find((check) => check.name === 'local dataset')?.status,
    'failed',
  );
  await mkdir(join(root, 'data'));
  const result = await sdkDoctor(options);
  assert.equal(
    result.checks.find((check) => check.name === 'local dataset')?.status,
    'passed',
  );
  assert.equal(
    result.checks.find((check) => check.name === 'model and task execution')
      ?.status,
    'not-checked',
  );
  assert.doesNotMatch(JSON.stringify(result), /fixture-only/);
  await assert.rejects(
    sdkDoctor({ ...options, env: {} }),
    /RSI_DOCTOR_LOCAL_AUTH/,
  );
});

test('native doctor observes cancellation before opening the configuration', async (t) => {
  const { options } = await fixture(t);
  const reason = new Error('RSI doctor cancelled');
  await assert.rejects(
    sdkDoctor({
      ...options,
      configPath: join(options.configPath, 'absent'),
      signal: AbortSignal.abort(reason),
    }),
    (error) => error === reason,
  );
});
