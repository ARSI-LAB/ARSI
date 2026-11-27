import { ObservationQueries } from '../../src/runtime/services/observation.js';
import {
  readAgentRecords,
  readAgentPayload,
} from '../../src/runtime/storage/agent-records.js';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { OperationDefinition } from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/index.js';
import { prepareAgentProject } from '../../src/plugins/shared/agent-editing/project.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Agent admission composes request transformations and records both waterfalls on the receipt', async () => {
  const agent: OperationDefinition = {
    id: 'test.admitted-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, ctx) {
          const running = await ctx.facts.read('calls', ctx.callId);
          assert.equal(running.status, 'running');
          assert.deepEqual(running.metadata, {
            inner: true,
            outer: true,
            admitted: true,
          });
          return { message: object(input).message! };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (ctx) => {
      ctx.event.on('rsi/before-agent-invoke', async (info, next) => {
        assert.equal(info.callerBindingId, ctx.bindingId);
        assert.equal(info.callerDirectory, ctx.directory);
        assert.equal(info.agentRef, 'agent');
        const current = await next();
        if (current.kind === 'reject') return current;
        return {
          kind: 'proceed',
          input: {
            ...current.input,
            message: current.input.message + '-outer',
          },
          metadata: { ...current.metadata, outer: true },
        };
      });
      ctx.event.on('rsi/before-agent-invoke', async (info, next) => {
        if (info.input.message === 'denied')
          return { kind: 'reject', reason: 'fixture veto' };
        const current = await next();
        if (current.kind === 'reject') return current;
        current.input.message += '-inner';
        assert.equal(info.input.message, 'test');
        return { ...current, metadata: { inner: true } };
      });
      ctx.event.on('rsi/before-call', async (_info, next) => {
        const current = await next();
        return current.kind === 'proceed'
          ? { ...current, metadata: { admitted: true } }
          : current;
      });
      const request = {
        message: 'test',
        cwd: await prepareAgentProject(ctx, 'test', {}, [], []),
        outputSchema: { type: 'object' },
      };
      await assert.rejects(
        ctx.invokeAgent('agent', { ...request, message: 'denied' }),
        /fixture veto/,
      );
      assert.deepEqual(await ctx.invokeAgent('agent', request), {
        message: 'test-inner-outer',
      });
      assert.equal(request.message, 'test');
      return {};
    },
    { plugins: [agent], bindings: { agent: { plugin: agent.id, config: {} } } },
  );
  try {
    await fixture.run();
    const receipts = (await fixture.manager.facts.list('calls')).filter(
      (call) => call.bindingId === 'agent',
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.status, 'succeeded');
    assert.equal(object(receipts[0]!.input).message, 'test-inner-outer');
    assert.deepEqual(receipts[0]!.metadata, {
      inner: true,
      outer: true,
      admitted: true,
    });
  } finally {
    await fixture.dispose();
  }
});

test('Agent invocation listeners cannot change the caller or the forwarded request by assignment', async (t) => {
  const agent: OperationDefinition = {
    id: 'test.echo-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return { execute: async (input) => input, async dispose() {} };
    },
  };
  const fixture = await managerFixture(
    async (ctx) => {
      const request = {
        message: 'original',
        cwd: await prepareAgentProject(ctx, 'test', {}, [], []),
        outputSchema: { type: 'object', required: ['message'] },
      };
      const expected = structuredClone(request);
      ctx.event.on('rsi/before-agent-invoke', (event, next) => {
        Reflect.set(event.input, 'message', 'changed');
        const required = event.input.outputSchema.required;
        assert.ok(Array.isArray(required));
        Reflect.set(required, 0, 'cwd');
        return next();
      });

      const received = await ctx.invokeAgent('agent', request);
      assert.deepEqual(
        { caller: request, agent: received },
        { caller: expected, agent: expected },
      );
      request.outputSchema.required.push('next');
      request.message = 'next';
      return {};
    },
    { plugins: [agent], bindings: { agent: { plugin: agent.id, config: {} } } },
  );
  t.after(() => fixture.dispose());
  await fixture.run();
});

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
        message: 'test routing',
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
      const receipts = (await context.facts.list('calls')).filter(
        (call) => call.pluginId === agent.id,
      );
      assert.equal(receipts.length, 3);
      for (const receipt of receipts) {
        assert.equal(receipt.contractId, 'contract.agent');
        assert.equal(receipt.status, 'succeeded');
        assert.equal(
          string(object(receipt.output).label),
          receipt.bindingId === 'agent.default' ? 'default' : receipt.bindingId,
        );
        const records = await readAgentRecords(
          join(
            context.dataDirectory,
            'experiments',
            context.experimentId,
            'calls',
            string(receipt.callId),
          ),
          0,
          100,
          true,
        );
        assert.equal(records.recording, 'closed');
        assert.deepEqual(records.items, []);
      }
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

for (const status of ['failed', 'cancelled'] as const) {
  test(`an explicit resume after ${status} keeps separate conversations and payloads`, async () => {
    let executions = 0;
    const agent: OperationDefinition = {
      id: 'test.retry-agent',
      contract: agentContract,
      configSchema: { type: 'object', additionalProperties: false },
      async create() {
        return {
          async execute(_input, context) {
            executions++;
            context.event.emit('rsi/agent-observation', {
              runId: 'main',
              event: {
                type: 'message.completed',
                messageId: 'answer',
                role: 'assistant',
                text: `attempt ${executions}`,
              },
            });
            context.event.emit('rsi/agent-observation', {
              runId: 'main',
              event: {
                type: 'tool.completed',
                toolCallId: 'large',
                status: executions === 1 ? 'failed' : 'succeeded',
                output: `payload ${executions}`.repeat(1000),
              },
            });
            if (executions === 1)
              throw Object.assign(new Error('retryable fixture failure'), {
                status,
              });
            return { answer: 'ok' };
          },
          async dispose() {},
        };
      },
    };
    const fixture = await managerFixture(
      async (context) => {
        const cwd = await prepareAgentProject(context, 'retry', {}, [], []);
        return context.invokeAgent('agent', {
          message: 'retry',
          cwd,
          outputSchema: { type: 'object' },
        });
      },
      {
        plugins: [agent],
        bindings: { agent: { plugin: agent.id, config: {} } },
      },
    );
    try {
      await assert.rejects(fixture.run(), /retryable fixture failure/);
      const failed = await fixture.manager.get('test');
      const result = await fixture.manager.run(string(failed.recipePath), {
        id: 'test',
        resume: true,
      });
      assert.equal(result.status, 'succeeded');
      const receipt = (await fixture.manager.facts.list('calls')).find(
        (call) => call.pluginId === agent.id,
      )!;
      const previous = await fixture.manager.facts.read(
        'call-attempts',
        string(receipt.recoveredFrom),
      );
      assert.equal(previous.status, status);
      const callDirectory = join(
        fixture.manager.directory,
        'experiments',
        'test',
        'calls',
        string(receipt.callId),
      );
      const current = await readAgentRecords(
        join(callDirectory, 'attempts', string(receipt.attemptId)),
        0,
        100,
        true,
      );
      const original = await readAgentRecords(callDirectory, 0, 100, true);
      for (const [records, attempt] of [
        [original, 1],
        [current, 2],
      ] as const) {
        assert.equal(records.items[0]?.sequence, 1);
        assert(
          records.items.some(
            (item) =>
              item.event.type === 'message.completed' &&
              item.event.text === `attempt ${attempt}`,
          ),
        );
      }
      const originalPayload = original.items.find(
        (item) => item.payload,
      )?.payload;
      assert(originalPayload);
      assert.equal(
        JSON.parse(
          (await readAgentPayload(callDirectory, originalPayload.ref)).toString(
            'utf8',
          ),
        ).output,
        'payload 1'.repeat(1000),
      );
      const queries = new ObservationQueries(
        fixture.manager.facts,
        fixture.manager.artifacts,
        fixture.manager.directory,
      );
      const trace = await queries.callTrace('test', string(receipt.callId));
      assert(
        trace.items.some(
          (item) =>
            object(item.event).type === 'message.completed' &&
            object(item.event).text === 'attempt 2',
        ),
      );
      const payload = trace.items.find((item) => item.payloadRef)?.payloadRef;
      assert(payload);
      const chunks: Buffer[] = [];
      for await (const chunk of await queries.agentPayload(
        'test',
        string(receipt.callId),
        payload,
      ))
        chunks.push(Buffer.from(chunk));
      assert.equal(
        JSON.parse(Buffer.concat(chunks).toString('utf8')).output,
        'payload 2'.repeat(1000),
      );
      assert.equal(executions, 2);
    } finally {
      await fixture.dispose();
    }
  });
}

test('an unknown outcome cannot replace its conversation without an explicit resume', async () => {
  let executions = 0;
  const agent: OperationDefinition = {
    id: 'test.unknown-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute() {
          executions++;
          throw Object.assign(new Error('unconfirmed fixture'), {
            status: 'unknown',
          });
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const scope = context.extend({
        scope: { id: 'unknown', signal: context.signal, limits: {} },
      });
      const request = {
        cwd: await prepareAgentProject(context, 'unknown', {}, [], []),
        message: 'unknown',
        outputSchema: { type: 'object' },
      };
      await assert.rejects(
        scope.invokeAgent('agent', request),
        /unconfirmed fixture/,
      );
      const receipt = (await context.facts.list('calls')).find(
        (call) => call.pluginId === agent.id,
      )!;
      const directory = join(
        context.dataDirectory,
        'experiments',
        context.experimentId,
        'calls',
        string(receipt.callId),
      );
      const before = await readAgentRecords(directory, 0, 100, true);
      await assert.rejects(
        scope.invokeAgent('agent', request),
        /requires a new resume attempt/,
      );
      assert.deepEqual(await readAgentRecords(directory, 0, 100, true), before);
      assert.deepEqual(await context.facts.list('call-attempts'), []);
      return {};
    },
    { plugins: [agent], bindings: { agent: { plugin: agent.id, config: {} } } },
  );
  try {
    await fixture.run();
    assert.equal(executions, 1);
  } finally {
    await fixture.dispose();
  }
});
