import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createRuntime } from '../../src/runtime/context.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';
import {
  initializeCampaign,
  runCampaign,
  reportCampaign,
} from '../../src/entries/cli/operator-experiments/campaign.js';

useOperatorSdkTestEnvironment();

test('campaign executes 22 distinct SDK evaluations, waits between batches and resumes without new effects', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  const host = { identity: 'test-host', ready: true };
  const snapshot = {
    recipePath: fixture.recipePath,
    identity: 'test-build-and-source',
  };
  const campaign = await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'campaign',
    hostIdentity: host.identity,
    inputIdentity: snapshot.identity,
    profiling: false,
    preflight: { ready: true, evidenceKind: 'test-fixture' },
  });
  let now = Date.now(),
    waited = 0;
  const options = {
    rootDirectory: fixture.root,
    id: campaign.id,
    manager: runtime.manager,
    observe: async () => host,
    prepare: async () => snapshot,
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        waited += ms;
        now += ms;
      },
    },
  };
  const report = await runCampaign(options);
  assert.equal(report.measurements.length, 20);
  assert.equal(
    new Set(
      report.experiments.flatMap((e) => e.measurements.map((m) => m.runId)),
    ).size,
    22,
  );
  assert.equal(report.evaluationRuns, 22);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.basicLoop, 'test-fixture');
  assert.equal(report.performance, 'test-fixture');
  assert.equal(report.statistics?.numericallyStable, true);
  assert.equal(report.statistics?.threshold, null);
  assert.ok(waited >= 600000);
  assert.equal(report.recovery, 'verified');
  const before = await runtime.manager.facts.list('calls');
  const resumed = await runCampaign({ ...options, resume: true });
  assert.equal(resumed.evaluationRuns, 22);
  assert.deepEqual(await runtime.manager.facts.list('calls'), before);
  const offline = await reportCampaign(options);
  assert.deepEqual(offline.measurements, report.measurements);
  assert.equal(offline.profiling, 'not-run');
  assert.match(await readFile(offline.reportPath, 'utf8'), /测试证据/);
  await assert.rejects(
    runCampaign({
      ...options,
      resume: true,
      observe: async () => ({ ready: true, identity: 'changed' }),
    }),
    /environment/,
  );
  await assert.rejects(
    initializeCampaign({
      rootDirectory: fixture.root,
      id: 'adjusted',
      hostIdentity: host.identity,
      inputIdentity: snapshot.identity,
      profiling: false,
      preflight: { ready: true },
      adjustment: { parentId: campaign.id, diagnosis: '' },
    }),
    /diagnosis/,
  );
  await rm(offline.reportPath.replace('report.md', 'batch-gap.json'));
  const withoutGap = await reportCampaign(options);
  assert.equal(withoutGap.performance, 'incomplete');
  assert.ok(withoutGap.errors.some((e) => e.error.includes('interval')));
});

test('a candidate correctness failure stops all remaining experiments and preserves actual usage', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const { appendFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await appendFile(
    join(fixture.root, 'example/baseline/input.py'),
    '\n# fixture:incorrect\n',
  );
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'invalid',
    hostIdentity: 'host',
    inputIdentity: 'inputs',
    profiling: false,
    preflight: { ready: true },
  });
  const options = {
    rootDirectory: fixture.root,
    id: 'invalid',
    manager: runtime.manager,
    observe: async () => ({ identity: 'host', ready: true }),
    prepare: async () => ({
      recipePath: fixture.recipePath,
      identity: 'inputs',
    }),
  };
  await assert.rejects(runCampaign(options));
  assert.equal((await runtime.manager.facts.list('experiments')).length, 1);
  const report = await reportCampaign(options);
  assert.equal(report.performance, 'incomplete');
  assert.ok(report.evaluationRuns > 0 && report.evaluationRuns <= 2);
  await assert.rejects(runCampaign({ ...options, resume: true }));
  assert.equal((await runtime.manager.facts.list('experiments')).length, 1);
});

test('failed or unknown experiment stops a campaign and cannot be retried by resume', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'stopped',
    hostIdentity: 'host',
    inputIdentity: 'inputs',
    profiling: false,
    preflight: { ready: true },
  });
  const options = {
    rootDirectory: fixture.root,
    id: 'stopped',
    manager: runtime.manager,
    observe: async () => ({ identity: 'host', ready: true }),
    prepare: async () => ({
      recipePath: fixture.recipePath,
      identity: 'inputs',
    }),
  };
  await runtime.manager.facts.write('experiments', 'stopped-initial', {
    id: 'stopped-initial',
    status: 'running',
  });
  await assert.rejects(
    runCampaign({ ...options, resume: true }),
    /unknown|unfinished/,
  );
  assert.equal((await runtime.manager.facts.list('calls')).length, 0);
  const report = await reportCampaign(options);
  assert.equal(report.performance, 'incomplete');
  assert.equal(report.statistics, null);
});

test('a fresh campaign cannot bypass unresolved operator effects from another campaign', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  await runtime.manager.facts.write('calls', 'old-unknown', {
    callId: 'old-unknown',
    experimentId: 'old-initial',
    pluginId: 'evaluator.operatorbench',
    status: 'unknown',
  });
  await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'fresh',
    hostIdentity: 'host',
    inputIdentity: 'inputs',
    profiling: false,
    preflight: { ready: true },
  });
  let prepared = false;
  await assert.rejects(
    runCampaign({
      rootDirectory: fixture.root,
      id: 'fresh',
      manager: runtime.manager,
      observe: async () => ({ identity: 'host', ready: true }),
      prepare: async () => {
        prepared = true;
        throw new Error('Unexpected device preparation');
      },
    }),
    /Unresolved operator/,
  );
  assert.equal(prepared, false);
  assert.equal((await runtime.manager.facts.list('experiments')).length, 0);
});

test('unknown outcome preserves device ownership and blocks a smoke test under a new ID', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  const { join } = await import('node:path');
  const { runNpuSmoke } = await import(
    '../../src/entries/cli/operator-experiments/preflight.js'
  );
  await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'unknown',
    hostIdentity: 'host',
    inputIdentity: 'inputs',
    profiling: false,
    preflight: { ready: true },
  });
  await assert.rejects(
    runCampaign({
      rootDirectory: fixture.root,
      id: 'unknown',
      manager: runtime.manager,
      observe: async () => ({ identity: 'host', ready: true }),
      prepare: async () => {
        await assert.rejects(
          runNpuSmoke({
            rootDirectory: fixture.root,
            directory: join(fixture.root, 'overlapping-smoke'),
            python: fixture.worker,
            device: 0,
          }),
          /Device.*owner/,
        );
        await runtime.manager.facts.write('calls', 'uncertain', {
          callId: 'uncertain',
          experimentId: 'unknown-initial',
          pluginId: 'evaluator.operatorbench',
          status: 'failed',
        });
        await runtime.manager.facts.write(
          'measurements',
          'uncertain-measurement',
          {
            experimentId: 'unknown-initial',
            callId: 'uncertain',
            evaluator: { pluginId: 'evaluator.operatorbench' },
            status: 'unknown',
          },
        );
        throw new Error('Device cleanup unknown');
      },
    }),
    /unknown/,
  );
  const owner = JSON.parse(
    await readFile(
      join(fixture.root, '.rsi/operator-calibration/device.lock/owner.json'),
      'utf8',
    ),
  );
  assert.equal(owner.status, 'unknown');
  await assert.rejects(
    runNpuSmoke({
      rootDirectory: fixture.root,
      directory: join(fixture.root, 'new-smoke'),
      python: fixture.worker,
      device: 0,
    }),
    /device.*owner|Device.*owner/,
  );
  await initializeCampaign({
    rootDirectory: fixture.root,
    id: 'replacement',
    hostIdentity: 'host',
    inputIdentity: 'inputs',
    profiling: false,
    preflight: { ready: true },
  });
  await assert.rejects(
    runCampaign({
      rootDirectory: fixture.root,
      id: 'replacement',
      manager: runtime.manager,
      observe: async () => ({ identity: 'host', ready: true }),
      prepare: async () => {
        throw new Error('Unexpected continuation');
      },
    }),
    /Device.*owner/,
  );
});
