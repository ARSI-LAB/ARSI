import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { managerFixture } from '../helpers/manager-fixture.js';

test('definition publication failure releases startup ownership before any plugin calls', async () => {
  let executions = 0;
  const fixture = await managerFixture(async () => {
    executions++;
    return {};
  });
  const failure = new Error('definition storage unavailable');
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'definitions') throw failure;
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), (error) => error === failure);
    await fixture.manager.dispose();
    assert.equal((await fixture.manager.get('test')).status, 'failed');
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
    assert.deepEqual(await fixture.manager.facts.list('calls'), []);
    assert.deepEqual(await fixture.manager.facts.list('event-diagnostics'), []);
    assert.equal(executions, 0);
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    await assert.rejects(
      fixture.manager.run(recipe, { id: 'test' }),
      /Experiment already exists/,
    );
    fixture.manager.facts.write = write;
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'recovered' })).status,
      'succeeded',
    );
    assert.equal(executions, 1);
  } finally {
    fixture.manager.facts.write = write;
    await fixture.dispose();
  }
});

test('dispose recovers a failed durable cleanup marker before attempting each disposer once', async () => {
  let disposals = 0;
  const fixture = await managerFixture(async () => ({}), {
    async disposeDriver() {
      disposals++;
    },
  });
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    if (kind === 'cleanup') throw new Error('cleanup storage unavailable');
    await write(kind, id, value);
  };
  try {
    await assert.rejects(fixture.run(), /cleanup storage unavailable/);
    assert.equal(disposals, 0);
    await assert.rejects(fixture.manager.dispose(), /cleanup failed/i);
    assert.equal(disposals, 0);
    fixture.manager.facts.write = write;
    await Promise.all([fixture.manager.dispose(), fixture.manager.dispose()]);
    assert.equal(disposals, 1);
    assert.equal(
      (await fixture.manager.facts.read('cleanup', 'test')).status,
      'succeeded',
    );
    await fixture.manager.dispose();
    assert.equal(disposals, 1);
    const recipe = join(fixture.manager.rootDirectory, 'recipe.yaml');
    assert.equal(
      (await fixture.manager.run(recipe, { id: 'test', resume: true })).status,
      'succeeded',
    );
    assert.equal(disposals, 1);
  } finally {
    fixture.manager.facts.write = write;
    await fixture.dispose();
  }
});
