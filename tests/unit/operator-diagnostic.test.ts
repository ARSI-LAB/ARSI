import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createRuntime } from '../../src/runtime/context.js';
import { object } from '../../src/shared/json.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';

useOperatorSdkTestEnvironment();

async function prepare(
  unavailable = false,
  collection = 'PipeTimeline,Default',
) {
  const fixture = await prepareOperatorFixture();
  const recipe = object(parse(await readFile(fixture.recipePath, 'utf8')));
  recipe.policy = {
    id: 'policy.operator-diagnostic',
    config: { caseIds: ['fixed'] },
  };
  const bindings = object(recipe.bindings);
  delete bindings.agent;
  delete bindings.proposer;
  const sdk = object(object(object(bindings.evaluator).config).sdk);
  const msprof = join(fixture.root, 'msprof.mjs');
  await copyFile(
    new URL('../fixtures/operator-sdk/msprof.mjs', import.meta.url),
    msprof,
  );
  await chmod(msprof, 0o755);
  sdk.profiling = {
    enabled: false,
    cacheEnabled: false,
    warmup: 25,
    collection,
    msprofBin: msprof,
    maxAttempts: 1,
    attemptTimeoutSeconds: 10,
  };
  if (unavailable) {
    const source = join(fixture.root, 'example/baseline/input.py');
    await writeFile(
      source,
      (await readFile(source, 'utf8')) + '\n# fixture:profile-unavailable\n',
    );
  }
  await writeFile(fixture.recipePath, stringify(recipe));
  return fixture;
}

for (const [collection, unavailable] of [
  ['PipeTimeline,Default', false],
  ['PipeTimeline,Default', true],
  ['Default', false],
  ['Default', true],
] as const) {
  test(`diagnostic precheck evaluates once then profiles once and resumes without calls (${collection}, ${unavailable ? 'unavailable' : 'completed'})`, async (t) => {
    const fixture = await prepare(unavailable, collection);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const runtime = await createRuntime({ rootDirectory: fixture.root });
    t.after(() => runtime.dispose());
    await runtime.manager.run(fixture.recipePath, { id: 'diagnostic' });
    const experiment = await runtime.manager.get('diagnostic');
    assert.equal(experiment.status, 'succeeded');
    const output = object(experiment.output);
    assert.equal(output.stopReason, 'diagnostic-only');
    assert.equal(
      output.collectionStatus,
      unavailable ? 'unavailable' : 'completed',
    );
    assert.equal(output.finalValidity, 'not-run');
    assert.equal(output.finalMeasurementRef, null);
    const measurements = await runtime.manager.facts.list('measurements');
    assert.equal(measurements.length, 2);
    const diagnostic = measurements.find(
      (m) => m.ref === output.diagnosticMeasurementRef,
    );
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.metrics, {});
    const details = object(
      await runtime.manager.artifacts.readJson(
        object(diagnostic.profile).artifactRef as string,
      ),
    );
    const profile = object(details.profile);
    const metadata = object(profile.metadata);
    assert.equal(metadata.collection, collection);
    if (!unavailable) {
      assert.equal(
        object(metadata.trace).status,
        collection === 'Default' ? 'unavailable' : 'available',
      );
      assert.ok(Array.isArray(profile.artifacts));
      assert.equal(
        profile.artifacts.some(
          (path) => typeof path === 'string' && path.endsWith('trace.json'),
        ),
        collection !== 'Default',
      );
    }
    const calls = await runtime.manager.facts.list('calls');
    const deviceCalls = calls.filter((c) => c.bindingId === 'evaluator');
    assert.deepEqual(deviceCalls.map((c) => object(c.input).action).sort(), [
      'evaluate',
      'profile',
    ]);
    const profileCall = deviceCalls.find(
      (c) => object(c.input).action === 'profile',
    );
    assert.ok(profileCall);
    assert.equal(
      object(profileCall.input).assessmentMeasurementRef,
      output.bestMeasurementRef,
    );
    assert.equal(
      calls.some((c) => ['agent', 'proposer'].includes(String(c.bindingId))),
      false,
    );
    assert.equal(object(experiment.usage).evaluationRuns, 2);
    await runtime.manager.run(fixture.recipePath, {
      id: 'diagnostic',
      resume: true,
    });
    assert.deepEqual(await runtime.manager.facts.list('calls'), calls);
    assert.deepEqual(
      await runtime.manager.facts.list('measurements'),
      measurements,
    );
    assert.deepEqual(
      (await runtime.manager.get('diagnostic')).usage,
      experiment.usage,
    );
  });
}

test('SDK precheck reports diagnostic availability without claiming independent retiming', async () => {
  const imported: unknown = await import(
    new URL('../../scripts/run-operator-sdk.mjs', import.meta.url).href
  );
  if (
    !imported ||
    typeof imported !== 'object' ||
    !('describeSdkOutcome' in imported) ||
    typeof imported.describeSdkOutcome !== 'function'
  )
    throw new Error('Missing SDK diagnostic reporting helper');
  const describe = imported.describeSdkOutcome;
  const describeSdkOutcome = (input: object) => {
    const outcome = object(describe(input));
    if (
      typeof outcome.claim !== 'string' ||
      typeof outcome.exitCode !== 'number'
    )
      throw new Error('Invalid SDK diagnostic outcome');
    return { claim: outcome.claim, exitCode: outcome.exitCode };
  };
  assert.equal(
    describeSdkOutcome({
      stopReason: 'diagnostic-only',
      collectionStatus: 'completed',
    }).exitCode,
    0,
  );
  const unavailable = describeSdkOutcome({
    stopReason: 'diagnostic-only',
    collectionStatus: 'unavailable',
  });
  assert.equal(unavailable.exitCode, 1);
  assert.match(unavailable.claim, /diagnostic/i);
  assert.doesNotMatch(unavailable.claim, /re-evaluation/i);
  assert.match(
    describeSdkOutcome({ stopReason: 'baseline-only' }).claim,
    /re-evaluation/i,
  );
});
