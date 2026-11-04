import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { createRuntime } from '../../src/runtime/context.js';
import { object } from '../../src/shared/json.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';
import { readExperimentEvidence } from '../../src/entries/cli/operator-experiments/evidence.js';

test('SDK baseline evaluates the unchanged source twice without any Agent binding and resumes without new effects', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const recipe = object(parse(await readFile(fixture.recipePath, 'utf8')));
  recipe.policy = {
    ref: 'policy.operator-baseline',
    config: { caseIds: ['fixed'] },
  };
  const bindings = object(recipe.bindings);
  delete bindings.agent;
  delete bindings.proposer;
  await writeFile(fixture.recipePath, stringify(recipe));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  await runtime.manager.run(fixture.recipePath, { id: 'baseline' });
  const experiment = await runtime.manager.get('baseline');
  assert.equal(experiment.status, 'succeeded');
  const output = object(experiment.output);
  assert.equal(output.stopReason, 'baseline-only');
  assert.equal(output.finalValidity, 'valid');
  assert.deepEqual(output.attempts, []);
  const evidence = await readExperimentEvidence(runtime.manager, 'baseline');
  assert.equal(evidence.measurements.length, 2);
  assert.notEqual(
    evidence.measurements[0]!.runId,
    evidence.measurements[1]!.runId,
  );
  assert.equal(
    evidence.measurements[0]!.sourceDigest,
    evidence.measurements[1]!.sourceDigest,
  );
  const calls = await runtime.manager.facts.list('calls');
  assert.equal(calls.filter((c) => c.bindingId === 'evaluator').length, 2);
  assert.equal(
    calls.some((c) => c.bindingId === 'agent' || c.bindingId === 'proposer'),
    false,
  );
  const before = {
    calls,
    measurements: await runtime.manager.facts.list('measurements'),
    candidates: await runtime.manager.facts.list('candidates'),
    usage: experiment.usage,
    output,
  };
  await runtime.manager.run(fixture.recipePath, {
    id: 'baseline',
    resume: true,
  });
  assert.deepEqual(await runtime.manager.facts.list('calls'), before.calls);
  assert.deepEqual(
    await runtime.manager.facts.list('measurements'),
    before.measurements,
  );
  assert.deepEqual(
    await runtime.manager.facts.list('candidates'),
    before.candidates,
  );
  const resumed = await runtime.manager.get('baseline');
  assert.deepEqual(resumed.usage, before.usage);
  assert.deepEqual(resumed.output, before.output);
});
