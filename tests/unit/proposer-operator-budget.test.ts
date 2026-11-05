import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContext, type AgentInput } from '../../src/contracts/index.js';
import { requestOperatorAgent } from '../../src/plugins/proposer-operator/execution-context.js';

test('operator stages derive separate scopes, preserve cancellation and reject an existing scope', async () => {
  const scopes: string[] = [];
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'parent',
    signal: new AbortController().signal,
    async invokeAgent(this: RuntimeContext, request) {
      assert.equal(request.maxModelCalls, 2);
      assert.deepEqual(request.input, {
        sourceFiles: { 'input.py': 'authorized source' },
      });
      assert.ok(typeof request.prompt === 'string');
      assert.match(request.prompt, /two total model calls/);
      assert.match(request.prompt, /do not delegate/i);
      assert.equal(this.scope?.limits.modelCalls, 2);
      assert.equal(this.scope?.signal, this.signal);
      const id = this.scope!.id;
      scopes.push(id);
      return {};
    },
  });
  const request: AgentInput = {
    goal: 'Test',
    prompt: 'test',
    files: { 'input.py': 'authorized source' },
    outputSchema: { type: 'object' },
  };
  await requestOperatorAgent('diagnose', request, context);
  await requestOperatorAgent('generate', request, context);
  assert.notEqual(scopes[0], scopes[1]);
  await assert.rejects(
    requestOperatorAgent(
      'generate',
      request,
      context.extend({
        scope: {
          id: 'outer',
          signal: context.signal,
          limits: { modelCalls: 100, evidenceBytes: 100 },
        },
      }),
    ),
    /scope/i,
  );
});

test('operator request uses the real Manager scope to stop recursive model effects before a third call', async (t) => {
  const { prepareOperatorFixture } = await import(
    '../fixtures/operator-sdk/setup.js'
  );
  const { createRuntime } = await import('../../src/runtime/context.js');
  const { agentContract, defineContract } = await import(
    '../../src/contracts/index.js'
  );
  const { object } = await import('../../src/shared/json.js');
  const { readFile, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { parse, stringify } = await import('yaml');
  const fixture = await prepareOperatorFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  let effects = 0;
  runtime.registry.registerOperation({
    id: 'agent.scope-test',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(request: AgentInput, context: RuntimeContext) {
          await context.charge('modelCalls', 1);
          effects++;
          const depth = Number(object(request.input ?? {}).depth ?? 0);
          if (depth < 2)
            return context.invokeAgent({
              ...request,
              input: { depth: depth + 1 },
            });
          return {};
        },
        async dispose() {},
      };
    },
  });
  const contract = defineContract({
    id: 'contract.scope-driver',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  runtime.registry.registerOperation({
    id: 'scope.driver',
    contract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, context) {
          return requestOperatorAgent(
            'generate',
            {
              agentRef: 'agent',
              goal: 'Bounded request',
              prompt: 'Test recursive model effects',
              input: { depth: 0 },
              outputSchema: { type: 'object' },
            },
            context,
          );
        },
        async dispose() {},
      };
    },
  });
  const path = join(fixture.root, 'scope.yaml');
  await writeFile(
    path,
    stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'scope.policy',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        agent: { contract: 'contract.agent' },
        driver: { contract: 'contract.scope-driver' },
      },
      state_schema: { type: 'object', additionalProperties: false },
      state: {},
      steps: [{ id: 'request', type: 'invoke', use: 'driver', with: {} }],
      output: '${{ steps.request.output }}',
    }),
  );
  runtime.registry.registerPolicy('scope.policy', path);
  const recipe = object(parse(await readFile(fixture.recipePath, 'utf8')));
  recipe.policy = { id: 'scope.policy' };
  recipe.bindings = {
    agent: { plugin: 'agent.scope-test', config: {} },
    driver: { plugin: 'scope.driver', config: {} },
  };
  recipe.budget = {
    operations: 20,
    modelCalls: 32,
    elapsedWallMs: 30000,
    cleanupReserveMs: 5000,
  };
  await writeFile(fixture.recipePath, stringify(recipe));
  await assert.rejects(
    runtime.manager.run(fixture.recipePath, { id: 'scope-cap' }),
    /modelCalls budget exceeded/i,
  );
  assert.equal(effects, 2);
  const budget = await runtime.manager.facts.read('budgets', 'scope-cap');
  assert.equal(budget.modelCalls, 2);
  const scopes = object(budget.scopes);
  assert.equal(Object.keys(scopes).length, 1);
  assert.equal(object(Object.values(scopes)[0]).modelCalls, 2);
});

test('operator model stage bounds both calls with one propagated timeout without cancelling its parent', async () => {
  const parent = new AbortController();
  const context = new RuntimeContext().extend({
    experimentId: 'bounded-experiment',
    callId: 'bounded-call',
    signal: parent.signal,
    async invokeAgent(this: RuntimeContext) {
      assert.equal(this.scope?.limits.elapsedWallMs, 25);
      return new Promise<never>((_resolve, reject) => {
        this.signal.addEventListener(
          'abort',
          () => reject(this.signal.reason),
          { once: true },
        );
      });
    },
  });
  const pending = requestOperatorAgent(
    'generate',
    {
      goal: 'Bounded request',
      prompt: 'Return JSON',
      outputSchema: { type: 'object' },
    },
    context,
    25,
  );
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(pending, /timeout|aborted/i);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(parent.signal.aborted, false);
});
