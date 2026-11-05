import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentContract,
  parseFileTree,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { memoryDefinition } from '../../src/plugins/memory-agent/index.js';
import { reflectionDefinition } from '../../src/plugins/reflection-agent/index.js';
import { object, string } from '../../src/shared/json.js';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';

const memoryState: JsonObject = {
  state_schema: {
    type: 'object',
    properties: { wikiRef: { type: ['string', 'null'] } },
    required: ['wikiRef'],
    additionalProperties: false,
  },
  state: { wikiRef: null },
};
const memorySteps: JsonObject[] = [
  {
    id: 'remember',
    type: 'invoke',
    use: 'memoryUpdater',
    with: {
      memoryRef: '${{ state.wikiRef }}',
      goal: 'Consolidate experience.',
      evidenceRefs: [],
    },
  },
  {
    id: 'save_memory',
    type: 'state',
    state: { wikiRef: '${{ steps.remember.output.memoryRef }}' },
  },
  { id: 'deliver', type: 'invoke', use: 'driver' },
];

test('Pi exhausts request retries while Memory and Reflection retain effective state, continue rounds and resume', async (t) => {
  const requests: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(object(JSON.parse(body)));
    if (requests.length > 2) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Fixture model unavailable' } }),
      );
      return;
    }
    const result = {
      edits: [
        {
          path:
            requests.length === 1
              ? 'wiki.md'
              : 'bindings/memoryUpdater/resources/prompt',
          content:
            requests.length === 1
              ? 'Retained experience.'
              : 'Revised Memory guidance.',
        },
      ],
      reason: 'Initial successful update.',
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: JSON.stringify(result) },
              finish_reason: 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const priorKey = process.env.RSI_OPTIONAL_UPDATES_TEST_KEY;
  process.env.RSI_OPTIONAL_UPDATES_TEST_KEY = 'local-fixture-key';
  t.after(() => {
    if (priorKey === undefined)
      delete process.env.RSI_OPTIONAL_UPDATES_TEST_KEY;
    else process.env.RSI_OPTIONAL_UPDATES_TEST_KEY = priorKey;
  });
  let deliveries = 0;
  const fixture = await managerFixture(
    async (context) => {
      deliveries++;
      const measurement = await measurementFixture(context);
      return { measurementRef: await context.recordMeasurement(measurement) };
    },
    {
      plugins: [piDefinition, memoryDefinition, reflectionDefinition],
      bindings: {
        agent: {
          plugin: piDefinition.id,
          config: {
            model: 'fixture',
            base_url: `http://127.0.0.1:${address.port}/v1`,
            api_key: '${RSI_OPTIONAL_UPDATES_TEST_KEY}',
            retries: 3,
            retryBaseDelayMs: 0,
            timeoutMs: 5000,
            executionTimeoutMs: 15000,
          },
        },
        memoryUpdater: {
          plugin: memoryDefinition.id,
          config: { prompt: './memory.md', agentRef: 'agent' },
        },
      },
      budget: { operations: 50, elapsedWallMs: 30000 },
      initialize(context) {
        context.event.on('rsi/call-failed', (event) => {
          if (event.bindingId === 'memoryUpdater')
            throw new Error('Optional failure listener failed');
        });
        return Promise.resolve();
      },
      policy: {
        ...memoryState,
        defaults: { reflection: { configFile: './reflection.yaml' } },
        steps: [
          {
            id: 'rounds',
            type: 'loop',
            maxIterations: 3,
            steps: [...memorySteps, { id: 'reflect', type: 'reflection' }],
          },
        ],
        output: { memoryRef: '${{ state.wikiRef }}' },
      },
    },
  );
  t.after(() => fixture.dispose());
  const root = fixture.manager.rootDirectory;
  await writeFile(join(root, 'memory.md'), 'Original Memory guidance.');
  await writeFile(join(root, 'reflection.md'), 'Improve authorized guidance.');
  await writeFile(join(root, 'goal.md'), 'Improve Memory guidance.');
  await writeFile(
    join(root, 'reflection.yaml'),
    JSON.stringify({
      evidence: ['driver', 'memoryUpdater'],
      targets: { memoryUpdater: { resources: ['prompt'] } },
      goal: './goal.md',
      implementation: {
        contract: reflectionDefinition.contract.id,
        ref: reflectionDefinition.id,
        config: { prompt: './reflection.md', agentRef: 'agent' },
      },
    }),
  );
  const controller = new AbortController();
  let interrupted = false;
  const write = fixture.manager.facts.write.bind(fixture.manager.facts);
  fixture.manager.facts.write = async (kind, id, value) => {
    await write(kind, id, value);
    if (
      !interrupted &&
      kind === 'calls' &&
      value.bindingId === 'memoryUpdater' &&
      value.status === 'failed'
    ) {
      interrupted = true;
      controller.abort(
        new Error(
          'Interrupt after failed Memory receipt, before Policy checkpoint',
        ),
      );
    }
  };
  const recipePath = join(root, 'recipe.yaml');
  await assert.rejects(
    fixture.manager.run(recipePath, { id: 'test', signal: controller.signal }),
    /Interrupt after failed Memory receipt/,
  );
  assert.equal((await fixture.manager.get('test')).status, 'cancelled');
  assert.equal(deliveries, 1);
  assert.equal(requests.length, 6);
  const result = await fixture.manager.run(recipePath, {
    id: 'test',
    resume: true,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(deliveries, 3);
  assert.equal(requests.length, 18);
  const calls = await fixture.manager.facts.list('calls');
  const memories = calls.filter((call) => call.bindingId === 'memoryUpdater');
  const succeeded = memories.find((call) => call.status === 'succeeded');
  assert.ok(succeeded);
  const originalMemory = object(succeeded.output).memoryRef;
  assert.equal(object(result.output).memoryRef, originalMemory);
  const failed = memories.filter((call) => call.status === 'failed');
  assert.equal(failed.length, 2);
  for (const call of failed) {
    assert.equal(object(call.output).status, 'failed');
    assert.equal(object(call.output).memoryRef, originalMemory);
    assert.equal(object(call.output).changeRef, null);
    assert.match(string(call.error), /503|unavailable/i);
  }
  const tree = parseFileTree(
    await fixture.manager.artifacts.readJson(string(originalMemory)),
  );
  assert.equal(
    Buffer.from(tree.files[0]!.base64, 'base64').toString('utf8'),
    'Retained experience.',
  );
  const reflections = await fixture.manager.facts.list('reflection');
  assert.equal(
    reflections.filter((record) => record.status === 'activated').length,
    1,
  );
  assert.equal(
    reflections.filter((record) => record.status === 'rejected').length,
    2,
  );
  const revision = (await fixture.manager.facts.list('revisions')).find(
    (record) => record.kind === 'generated',
  );
  assert.ok(revision);
  assert.ok(failed.every((call) => call.revisionRef === revision.ref));
  assert.match(JSON.stringify(requests[2]), /Revised Memory guidance/);
  assert.match(JSON.stringify(requests[10]), /Revised Memory guidance/);
  assert.equal(
    (await fixture.manager.facts.read('budgets', 'test')).modelCalls,
    18,
  );
  assert.equal(
    await readFile(join(root, 'memory.md'), 'utf8'),
    'Original Memory guidance.',
  );
  assert.deepEqual(await readdir(join(root, '.rsi', 'workspaces')), []);
  await fixture.manager.run(recipePath, { id: 'test', resume: true });
  assert.equal(requests.length, 18);
  assert.equal(deliveries, 3);
});

test('Memory preparation failures continue with null state while cancellation and budget persistence failures stop', async (t) => {
  for (const outcome of ['preparation', 'cancelled', 'budget', 'ledger']) {
    await t.test(outcome, async (t) => {
      let generations = 0;
      let deliveries = 0;
      const agent: OperationDefinition = {
        id: 'test.optional-agent',
        contract: agentContract,
        configSchema: { type: 'object' },
        async create() {
          return {
            async execute(_input, context) {
              generations++;
              if (outcome === 'cancelled') await fixture.manager.cancel('test');
              else await context.charge('modelCalls', 1);
              throw new Error('Model failed');
            },
            async dispose() {},
          };
        },
      };
      const steps = structuredClone(memorySteps);
      if (outcome === 'preparation')
        object(steps[0]!.with).evidenceRefs = ['missing-measurement'];
      const fixture = await managerFixture(
        async () => {
          deliveries++;
          return {};
        },
        {
          plugins: [agent, memoryDefinition],
          bindings: {
            agent: { plugin: agent.id, config: {} },
            memoryUpdater: {
              plugin: memoryDefinition.id,
              config: { prompt: './memory.md', agentRef: 'agent' },
            },
          },
          budget: { modelCalls: outcome === 'budget' ? 0 : 10 },
          policy: {
            ...memoryState,
            steps,
            output: { memoryRef: '${{ state.wikiRef }}' },
          },
        },
      );
      t.after(() => fixture.dispose());
      await writeFile(
        join(fixture.manager.rootDirectory, 'memory.md'),
        'Maintain Memory.',
      );
      if (outcome === 'ledger') {
        const write = fixture.manager.facts.write.bind(fixture.manager.facts);
        fixture.manager.facts.write = async (kind, id, value) => {
          if (kind === 'budgets' && value.modelCalls === 1)
            throw new Error('Budget persistence failed');
          await write(kind, id, value);
        };
      }
      if (outcome === 'preparation') {
        const result = await fixture.run();
        assert.equal(result.status, 'succeeded');
        assert.equal(object(result.output).memoryRef, null);
        assert.equal(deliveries, 1);
        assert.equal(generations, 0);
        const memory = (await fixture.manager.facts.list('calls')).find(
          (call) => call.bindingId === 'memoryUpdater',
        );
        assert.equal(memory?.status, 'failed');
        assert.equal(object(memory!.output).status, 'failed');
      } else {
        await assert.rejects(
          fixture.run(),
          outcome === 'cancelled'
            ? /cancelled/
            : outcome === 'budget'
              ? /Budget exceeded/
              : /Budget persistence failed/,
        );
        assert.equal(
          (await fixture.manager.get('test')).status,
          outcome === 'cancelled' ? 'cancelled' : 'failed',
        );
        assert.equal(deliveries, 0);
        assert.equal(generations, 1);
      }
    });
  }
});
