import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationDefinition } from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/index.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
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
      const request = {
        goal: 'test routing',
        cwd: await prepareAgentProject(context, 'test', {}, [], []),
        outputSchema: { type: 'object' },
      };
      assert.deepEqual(await context.invokeAgent('second', request), {
        label: 'second',
      });
      assert.deepEqual(await context.invokeAgent('first', request), {
        label: 'first',
      });
      assert.deepEqual(await context.invokeAgent('agent.default', request), {
        label: 'default',
      });
      const before = await context.facts.read('budgets', context.experimentId);
      await assert.rejects(
        context.invokeAgent(agent.id, request),
        /Unknown Agent test.shared-agent/,
      );
      await assert.rejects(
        context.invokeAgent('missing', request),
        /Unknown Agent missing/,
      );
      await assert.rejects(
        context.invokeAgent('driver', request),
        /does not implement contract\.agent/,
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
        first: { plugin: agent.id, config: { label: 'first' } },
        second: { plugin: agent.id, config: { label: 'second' } },
        'agent.default': { plugin: agent.id, config: { label: 'default' } },
      },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
  } finally {
    await fixture.dispose();
  }
});
