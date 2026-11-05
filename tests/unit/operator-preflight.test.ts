import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectNpuHost,
  runNpuSmoke,
} from '../../src/entries/cli/operator-experiments/preflight.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';

useOperatorSdkTestEnvironment();

test('preflight preserves missing interpreter as failure and never silently falls back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  const originalCannHome = process.env.ASCEND_HOME_PATH;
  process.env.PATH = root;
  process.env.ASCEND_HOME_PATH = root;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCannHome === undefined) delete process.env.ASCEND_HOME_PATH;
    else process.env.ASCEND_HOME_PATH = originalCannHome;
  });
  const report = await inspectNpuHost({
    rootDirectory: root,
    python: join(root, 'missing-python'),
    device: 0,
  });
  assert.equal(report.ready, false);
  assert.ok(report.issues.some((issue) => issue.includes('Python')));
  assert.equal(report.python, null);
  assert.equal(report.deviceQuery.status, 'unavailable');
});
test('preflight failure retains SDK cleanup evidence and pre-start cancellation spends no evaluation', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(
    fixture.worker,
    (await readFile(fixture.worker, 'utf8')).replace(
      "source.includes('fixture:infrastructure')",
      'true',
    ),
  );
  const report = await runNpuSmoke({
    rootDirectory: fixture.root,
    directory: join(fixture.root, 'failed'),
    python: fixture.worker,
    device: 0,
  });
  assert.equal(report.ready, false);
  assert.equal(report.cleanup, 'confirmed');
  assert.ok(report.runId);
  const cancelled = await runNpuSmoke({
    rootDirectory: fixture.root,
    directory: join(fixture.root, 'cancelled'),
    python: fixture.worker,
    device: 0,
    signal: AbortSignal.abort(),
  });
  assert.equal(cancelled.evaluationRuns, 0);
  assert.equal(cancelled.status, 'cancelled');
});
test('preflight smoke uses the full SDK and labels device fixture evidence', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const report = await runNpuSmoke({
    rootDirectory: fixture.root,
    directory: join(fixture.root, 'smoke'),
    python: fixture.worker,
    device: 0,
  });
  assert.equal(report.status, 'test-fixture');
  assert.equal(report.evaluationRuns, 1);
  assert.equal(report.ready, false);
  assert.equal(report.cleanup, 'confirmed');
  assert.ok(report.runId);
});
