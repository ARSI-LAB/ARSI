import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, Recipe } from 'ember-rsi';
const root = fileURLToPath(new URL('.', import.meta.url));
const runtime = await createRuntime({
  rootDirectory: root,
  directory: resolve(root, '.rsi'),
  pluginDirectories: [resolve(root, 'extension')],
});
try {
  const path = resolve(root, 'recipe.yaml');
  await Recipe.load(path, runtime.registry);
  const id = 'skill-' + Date.now();
  const result = await runtime.manager.run(path, { id });
  assert.equal(result.status, 'succeeded');
  const record = await runtime.manager.get(id);
  const measurements = (
    await runtime.manager.facts.list('measurements')
  ).filter((m) => m.experimentId === id);
  assert.deepEqual(
    measurements.map((m) => m.metrics.checkPhrase.value.value).sort(),
    [0, 1],
  );
  const selected = await runtime.manager.facts.read(
    'measurements',
    record.output.measurementRef,
  );
  assert.equal(selected.candidateRef, record.output.candidateRef);
  assert.equal(selected.metrics.checkPhrase.value.value, 1);
  assert.equal(record.usage.modelCalls ?? 0, 0);
  const candidates = (await runtime.manager.facts.list('candidates')).filter(
    (c) => c.experimentId === id,
  );
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some((c) => c.parentRef === null));
  const instances = (await runtime.manager.facts.list('instances')).filter(
    (i) => i.experimentId === id,
  );
  assert.equal(instances.length, 2);
  assert.ok(instances.every((i) => i.status === 'released'));
  const resumed = await runtime.manager.run(path, { id, resume: true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(
    (await runtime.manager.facts.list('measurements')).filter(
      (m) => m.experimentId === id,
    ).length,
    2,
  );
  console.log(
    JSON.stringify({
      id,
      status: record.status,
      scores: [0, 1],
      candidates: candidates.length,
      releasedInstances: instances.length,
      successfulResumeDidNotReplay: true,
    }),
  );
} finally {
  await runtime.dispose();
}
