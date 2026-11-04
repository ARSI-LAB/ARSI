import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createRuntime } from '../../src/runtime/context.js';
import { object } from '../../src/shared/json.js';
import { prepareOperatorFixture } from '../fixtures/operator-sdk/setup.js';
import { readExperimentEvidence } from '../../src/entries/cli/operator-experiments/evidence.js';

test('calibration audits two real SDK measurements and rejects damaged archived CSV', async (t) => {
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  await runtime.manager.run(fixture.recipePath, { id: 'evidence' });
  const evidence = await readExperimentEvidence(runtime.manager, 'evidence');
  assert.equal(evidence.measurements.length, 2);
  assert.equal(evidence.measurements[0].candidateMs, 10);
  assert.notEqual(
    evidence.measurements[0].runId,
    evidence.measurements[1].runId,
  );
  assert.equal(evidence.fixture, true);
  assert.equal(evidence.sourceUnchanged, true);
  assert.equal(evidence.measurements[0].warmup, 5);
  const artifacts = new Proxy(runtime.manager.artifacts, {
    get(target, name) {
      if (name !== 'readJson') return Reflect.get(target, name);
      return async (ref: string) => {
        const value = structuredClone(await target.readJson(ref));
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.kind === 'file-tree' &&
          Array.isArray(value.files)
        ) {
          for (const item of value.files) {
            const file = object(item);
            if (String(file.path).endsWith('kernel_details.csv'))
              file.base64 = Buffer.from('broken CSV').toString('base64');
          }
        }
        return value;
      };
    },
  });
  await assert.rejects(
    readExperimentEvidence(
      {
        ...runtime.manager,
        artifacts,
        get: runtime.manager.get.bind(runtime.manager),
      },
      'evidence',
    ),
    /CSV/,
  );
});
