import test from 'node:test';
import assert from 'node:assert/strict';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';
import { object, string, digest } from '../../src/shared/json.js';

test('Manager accepts plugin-private artifacts without global Schema registration', async () => {
  const fixture = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    return { ref: await context.recordMeasurement(measurement) };
  });
  try {
    const result = await fixture.run();
    const measurement = await fixture.manager.facts.read(
      'measurements',
      string(object(result.output).ref),
    );
    assert.equal(object(measurement.profile).schemaId, 'test.private/v1');
    assert.deepEqual(
      await fixture.manager.artifacts.readJson(
        string(object(measurement.profile).artifactRef),
      ),
      { privateValue: 'owned by plugin' },
    );
  } finally {
    await fixture.dispose();
  }
});

for (const failure of [
  'missing artifact',
  'invalid items',
  'invalid evidence',
  'invalid metric',
] as const) {
  test(`Manager rejects ${failure} without persisting a Measurement`, async () => {
    const fixture = await managerFixture(async (context) => {
      const measurement = await measurementFixture(context);
      if (failure === 'missing artifact')
        object(measurement.profile).artifactRef = `artifact:${'0'.repeat(64)}`;
      if (failure === 'invalid items')
        measurement.itemsRef = await context.artifacts.putJson({
          items: [{}],
        });
      if (failure === 'invalid evidence')
        measurement.evidenceIndexRef = await context.artifacts.putJson({
          entries: [{}],
        });
      if (failure === 'invalid metric') {
        object(object(measurement.metrics).score).definitionRef =
          await context.artifacts.putJson({ id: 'invalid' });
      }
      return { ref: await context.recordMeasurement(measurement) };
    });
    try {
      await assert.rejects(
        fixture.run(),
        failure === 'missing artifact'
          ? /ENOENT/
          : failure === 'invalid items'
            ? /Measurement items/
            : failure === 'invalid evidence'
              ? /Measurement evidence/
              : /metric definition/,
      );
      assert.deepEqual(await fixture.manager.facts.list('measurements'), []);
    } finally {
      await fixture.dispose();
    }
  });
}

test('Manager records a cloned frozen Measurement with normalized content identity', async () => {
  const fixture = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    measurement.evaluator = {
      pluginId: 'adapter.not-registered',
      implementationDigest: 'adapter-v1',
    };
    const before = structuredClone(measurement);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(measurement);
    const first = await context.recordMeasurement(measurement);
    const second = await context.recordMeasurement(measurement);
    assert.equal(first, second);
    assert.deepEqual(measurement, before);
    const saved = await context.readMeasurement(first);
    const { ref: _ref, ...content } = saved;
    assert.equal(first, 'measurement-' + digest(content));
    assert.equal(object(saved.evaluator).pluginId, 'test.driver');
    return { ref: first };
  });
  try {
    await fixture.run();
    assert.equal((await fixture.manager.facts.list('measurements')).length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('Manager rejects foreign Measurement ownership before normalization without mutating input', async () => {
  const fixture = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    measurement.experimentId = 'another-experiment';
    const before = structuredClone(measurement);
    await assert.rejects(context.recordMeasurement(measurement), /ownership/);
    assert.deepEqual(measurement, before);
    return {};
  });
  try {
    await fixture.run();
    assert.deepEqual(await fixture.manager.facts.list('measurements'), []);
  } finally {
    await fixture.dispose();
  }
});

test('Manager reads existing Measurement references without recomputing their identity', async () => {
  const fixture = await managerFixture(async (context) => {
    const measurement = await measurementFixture(context);
    measurement.ref = 'measurement-old-content-identity';
    await context.facts.write('measurements', measurement.ref, measurement);
    assert.deepEqual(
      await context.readMeasurement(measurement.ref),
      measurement,
    );
    return {};
  });
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});
