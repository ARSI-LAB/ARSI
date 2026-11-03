import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/index.js';
import { string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Manager invokes exact Agent bindings and never falls back to an implementation ID', async () => {
  let executions = 0;
  const agent: OperationDefinition = {
    id: 'test.shared-agent',
    contract: agentContract,
    configSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
    async create(config) {
      const label = string(config.label);
      return {
        async execute() {
          executions++;
          return { label };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const request: JsonObject = {
        goal: 'test routing',
        prompt: 'test',
        outputSchema: { type: 'object' },
      };
      assert.deepEqual(
        await context.invokeAgent({ ...request, agentRef: 'second' }),
        { label: 'second' },
      );
      assert.deepEqual(
        await context.invokeAgent({ ...request, agentRef: 'first' }),
        { label: 'first' },
      );
      assert.deepEqual(await context.invokeAgent(request), {
        label: 'default',
      });
      const before = await context.facts.read('budgets', context.experimentId);
      await assert.rejects(
        context.invokeAgent({ ...request, agentRef: agent.id }),
        /Unknown Agent test.shared-agent/,
      );
      await assert.rejects(
        context.invokeAgent({ ...request, agentRef: 'missing' }),
        /Unknown Agent missing/,
      );
      assert.deepEqual(
        await context.facts.read('budgets', context.experimentId),
        before,
      );
      assert.equal(executions, 3);
      return {};
    },
    {
      plugins: [agent],
      bindings: {
        first: { ref: agent.id, config: { label: 'first' } },
        second: { ref: agent.id, config: { label: 'second' } },
        'agent.default': { ref: agent.id, config: { label: 'default' } },
      },
    },
  );
  try {
    await fixture.run();
  } finally {
    await fixture.dispose();
  }
});
