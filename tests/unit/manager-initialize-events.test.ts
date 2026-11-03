import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  defineContract,
  type OperationDefinition,
  type RuntimeContext,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('resume recovers a committed initialize result when its success listener cancelled startup', async () => {
  const cancellation = new AbortController();
  let services: RuntimeContext | undefined;
  let candidateNotifications = 0;
  let initializationNotifications = 0;
  let executions = 0;
  const observer: OperationDefinition = {
    id: 'test.initialize-observer',
    contract: defineContract({
      id: 'contract.test-initialize-observer',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    }),
    configSchema: { type: 'object' },
    async create(_config, supplied) {
      services = supplied;
      supplied.event.on('rsi/candidate-recorded', () => {
        candidateNotifications++;
      });
      supplied.event.on('rsi/call-succeeded', (event) => {
        if (event.bindingId !== '_application') return;
        initializationNotifications++;
        cancellation.abort(new Error('cancelled initialization notification'));
      });
      return {
        async execute() {
          return {};
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      executions++;
      return context.applicationMetadata();
    },
    {
      initialize: async (ctx) => {
        await ctx.invoke('observer', {});
      },
      plugins: [observer],
      bindings: { observer: { ref: observer.id, config: {} } },
    },
  );
  try {
    await assert.rejects(
      fixture.manager.run(join(fixture.manager.rootDirectory, 'recipe.yaml'), {
        id: 'test',
        signal: cancellation.signal,
      }),
      /cancelled initialization notification/,
    );
    assert.equal((await fixture.manager.get('test')).status, 'cancelled');
    const initialize = (await fixture.manager.facts.list('calls')).find(
      (call) => call.bindingId === '_application',
    );
    assert.equal(initialize?.status, 'succeeded');
    const initialized = object(initialize?.output);
    assert.equal(typeof initialized.initialCandidateRef, 'string');
    assert.ok(services);
    const result = await fixture.manager.run(
      join(services.rootDirectory, 'recipe.yaml'),
      { id: 'test', resume: true },
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.output, {
      target: initialized.target,
      capabilities: initialized.capabilities,
      initialCandidateRef: initialized.initialCandidateRef,
    });
    assert.equal(candidateNotifications, 1);
    assert.equal(initializationNotifications, 1);
    assert.equal(executions, 1);
    const calls = await fixture.manager.facts.list('calls');
    assert.equal(
      calls.filter((call) => call.bindingId === '_application').length,
      1,
    );
    assert.equal(
      (await fixture.manager.facts.read('budgets', 'test')).operations,
      3,
    );
  } finally {
    await fixture.dispose();
  }
});
