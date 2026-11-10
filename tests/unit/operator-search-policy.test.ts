import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  agentContract,
  type AgentInput,
  type AgentOutput,
  type JsonObject,
  type OperationDefinition,
} from '../../src/contracts/index.js';
import { createRuntime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { object, string } from '../../src/shared/json.js';
import {
  prepareOperatorProposerFixture,
  operatorFixtureSource,
} from '../fixtures/operator-proposer/setup.js';

useOperatorSdkTestEnvironment();

async function setup(
  t: TestContext,
  options: {
    markers?: string[];
    noIssues?: boolean;
    maxAttempts?: number;
    repairLimit?: number;
    budget?: JsonObject;
    failSummary?: boolean;
  } = {},
) {
  const fixture = await prepareOperatorProposerFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const recipe = object(parse(await readFile(fixture.recipePath, 'utf8')));
  recipe.policy = {
    id: 'policy.operator-search',
    config: {
      goal: 'Test-only functional search',
      caseIds: ['fixed'],
      maxAttempts: options.maxAttempts ?? 3,
      repairLimit: options.repairLimit ?? 3,
    },
  };
  const bindings = object(recipe.bindings);
  bindings.agent = { plugin: 'agent.operator-policy-fixture', config: {} };
  bindings.proposer = {
    plugin: 'proposer.operator',
    config: {
      agentRef: 'agent',
      task: { directory: join(fixture.root, 'example/task') },
      embedding: {
        python: fixture.embeddingPython,
        modelDirectory: fixture.modelDirectory,
        identityFile: fixture.identityFile,
        resourcesDirectory: fixture.resourcesDirectory,
        retrievalScript: fixture.retrievalScript,
      },
    },
  };
  recipe.budget = {
    operations: 256,
    evaluationRuns: 14,
    modelCalls: 32,
    elapsedWallMs: 2400000,
    cleanupReserveMs: 60000,
    ...options.budget,
  };
  await writeFile(fixture.recipePath, stringify(recipe));
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  t.after(() => runtime.dispose());
  const requests: { input: JsonObject; source: string }[] = [];
  let generated = 0;
  const agent: OperationDefinition<AgentInput, AgentOutput, JsonObject> = {
    id: 'agent.operator-policy-fixture',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(request, context): Promise<JsonObject> {
          const input = object(
            JSON.parse(
              await readFile(join(request.cwd, 'context/input.json'), 'utf8'),
            ),
          );
          requests.push({
            input,
            source: await readFile(
              join(request.cwd, 'context/sources', string(input.sourcePath)),
              'utf8',
            ),
          });
          await context.charge('modelCalls', 1);
          const stage = input.stage;
          if (stage === 'diagnose')
            return {
              issues: options.noIssues
                ? []
                : [
                    {
                      issue_type: 'loop_invariant_hoisting',
                      issue_summary: 'Invariant expression inside loop',
                      problematic_code: ['        y = x + 1'],
                      evidence: ['x does not change in the visible loop'],
                    },
                  ],
            };
          if (stage === 'summarize') {
            if (options.failSummary) throw new Error('Fixture summary failure');
            return {
              explanation: 'Measured facts guide the next attempt',
              lessons: ['Measured fixture feedback'],
              avoidPatterns: ['Repeat failed changes'],
              tryPatterns: ['Use another source-backed hypothesis'],
            };
          }
          const marker = options.markers?.[generated++];
          return {
            edits: marker
              ? [
                  {
                    path: string(input.sourcePath),
                    content: operatorFixtureSource(marker),
                  },
                ]
              : [],
            reason: 'Fixture source change',
          };
        },
        async dispose() {},
      };
    },
  };
  runtime.registry.registerOperation(agent);
  return { ...fixture, ...runtime, requests };
}

test('operator search inherits policy prompt paths while resolving recipe overrides from the recipe', async (t) => {
  const f = await setup(t);
  const recipe = await Recipe.load(f.recipePath, f.registry);
  assert.equal(
    recipe.bindings.proposer!.config.promptsDirectory,
    fileURLToPath(
      new URL('../../src/policies/operator-search/prompts', import.meta.url),
    ),
  );
  assert.equal(
    recipe.bindings.summarizer!.config.promptFile,
    fileURLToPath(
      new URL(
        '../../src/policies/operator-search/prompts/summarize.md',
        import.meta.url,
      ),
    ),
  );
  assert.equal(
    object(recipe.bindings.proposer!.config.task).directory,
    join(f.root, 'example/task'),
  );
  const overridden = object(parse(await readFile(f.recipePath, 'utf8')));
  object(object(object(overridden.bindings).proposer).config).promptsDirectory =
    './custom-prompts';
  await writeFile(f.recipePath, stringify(overridden));
  const custom = await Recipe.load(f.recipePath, f.registry);
  assert.equal(
    custom.bindings.proposer!.config.promptsDirectory,
    join(f.root, 'example/custom-prompts'),
  );
});

test('static SDK search summarizes a failed repair chain and delivers it to a fresh entry attempt before adopting and retesting', async (t) => {
  const f = await setup(t, {
    markers: [
      'fixture:incorrect',
      'fixture:latency=12',
      'fixture:incorrect # second attempt',
      'fixture:latency=8',
    ],
  });
  const experiment = await f.manager.run(f.recipePath, { id: 'static-search' });
  assert.equal(experiment.status, 'succeeded');
  const output = object(experiment.output);
  const attempts = (output.attempts as JsonObject[]).map((value) =>
    object(value),
  );
  assert.deepEqual(
    attempts.map((a) => [a.outcome, a.repairCount, a.accepted]),
    [
      ['verified-no-gain', 1, false],
      ['adopted', 1, true],
    ],
  );
  assert.equal(output.stopReason, 'accepted');
  assert.equal(output.finalValidity, 'valid');
  assert.equal(output.finalTimingStable, true);
  assert.equal(output.historyRef, attempts[1]!.historyRef);
  assert.deepEqual(
    f.requests.map((r) => object(r.input).stage),
    [
      'diagnose',
      'generate',
      'repair',
      'summarize',
      'generate',
      'repair',
      'summarize',
    ],
  );
  assert.equal(
    f.requests[2]!.source,
    operatorFixtureSource('fixture:incorrect'),
  );
  assert.equal(f.requests[4]!.source, f.entrySource);
  assert.match(
    JSON.stringify(object(f.requests[4]!.input).history),
    /candidateMs.*12/,
  );
  assert.match(
    JSON.stringify(object(f.requests[4]!.input).history),
    /Measured fixture feedback/,
  );
  const best = await f.manager.facts.read(
    'candidates',
    string(output.bestCandidateRef),
  );
  const winningParent = await f.manager.facts.read(
    'candidates',
    string(best.parentRef),
  );
  assert.equal(
    winningParent.parentRef,
    object(experiment.application).initialCandidateRef,
  );
  assert.equal(object(experiment.usage).evaluationRuns, 6);
  const calls = await f.manager.facts.list('calls');
  const resumed = await f.manager.run(f.recipePath, {
    id: 'static-search',
    resume: true,
  });
  assert.deepEqual(resumed.usage, experiment.usage);
  assert.deepEqual(await f.manager.facts.list('calls'), calls);
  assert.ok(
    (await f.manager.facts.list('instances')).every(
      (i) => i.status === 'released',
    ),
  );
});

test('empty diagnosis performs only baseline and final SDK measurements without a fabricated summary', async (t) => {
  const f = await setup(t, { noIssues: true });
  const result = await f.manager.run(f.recipePath, { id: 'no-issues' });
  const output = object(result.output);
  assert.equal(output.stopReason, 'no-static-issues');
  assert.deepEqual(output.attempts, []);
  assert.equal(output.historyRef, null);
  assert.equal(object(result.usage).evaluationRuns, 2);
  assert.equal(object(result.usage).modelCalls, 1);
  assert.equal(f.requests.length, 1);
});

test('three unchanged attempts each receive a real summary while SDK only evaluates baseline and final', async (t) => {
  const f = await setup(t);
  const result = await f.manager.run(f.recipePath, { id: 'unchanged' });
  const output = object(result.output);
  assert.equal(output.stopReason, 'max-attempts');
  assert.deepEqual(
    (output.attempts as JsonObject[]).map((a) => a.outcome),
    ['no-change', 'no-change', 'no-change'],
  );
  assert.equal(object(result.usage).evaluationRuns, 2);
  assert.equal(object(result.usage).modelCalls, 7);
});

test('three attempts with three repairs stay within fourteen SDK runs and restart from entry source', async (t) => {
  const f = await setup(t, {
    markers: Array.from(
      { length: 12 },
      (_, i) => `fixture:incorrect # variant-${i}`,
    ),
  });
  const result = await f.manager.run(f.recipePath, { id: 'repair-ceiling' });
  const output = object(result.output);
  assert.deepEqual(
    (output.attempts as JsonObject[]).map((a) => [a.outcome, a.repairCount]),
    Array.from({ length: 3 }, () => ['verification-failed', 3]),
  );
  assert.equal(object(result.usage).evaluationRuns, 14);
  assert.equal(object(result.usage).modelCalls, 16);
  const fresh = f.requests.filter((r) => object(r.input).stage === 'generate');
  assert.equal(fresh.length, 3);
  assert.ok(fresh.every((r) => r.source === f.entrySource));
  assert.equal(
    output.bestCandidateRef,
    object(result.application).initialCandidateRef,
  );
});

test('configured static attempts and repairs exceed former ceilings and resume recorded histories', async (t) => {
  const f = await setup(t, {
    maxAttempts: 4,
    repairLimit: 4,
    markers: Array.from(
      { length: 20 },
      (_, i) => `fixture:incorrect # extended-${i}`,
    ),
    budget: { evaluationRuns: 22, modelCalls: 32 },
  });
  const result = await f.manager.run(f.recipePath, { id: 'extended-static' });
  const output = object(result.output);
  const attempts = output.attempts as JsonObject[];
  assert.equal(output.stopReason, 'max-attempts');
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every((attempt) => attempt.repairCount === 4));
  assert.ok(
    attempts.every(
      (attempt) => (attempt.candidateRefs as string[]).length === 5,
    ),
  );
  assert.equal(object(result.usage).evaluationRuns, 22);
  const lastGeneration = f.requests
    .filter((request) => object(request.input).stage === 'generate')
    .at(-1)!;
  assert.equal(
    (object(lastGeneration.input).history as JsonObject[]).length,
    3,
  );
  const finalHistory = object(
    await f.manager.artifacts.readJson(string(output.historyRef)),
  );
  assert.equal((finalHistory.summaryRefs as string[]).length, 4);
  const calls = await f.manager.facts.list('calls');
  const resumed = await f.manager.run(f.recipePath, {
    id: 'extended-static',
    resume: true,
  });
  assert.deepEqual(resumed.output, result.output);
  assert.deepEqual(await f.manager.facts.list('calls'), calls);
});

test('summary failure prevents adoption and resume cannot replay the unfinished action', async (t) => {
  const f = await setup(t, {
    markers: ['fixture:latency=8'],
    failSummary: true,
  });
  await assert.rejects(
    f.manager.run(f.recipePath, { id: 'failed-summary' }),
    /Fixture summary failure/,
  );
  const before = {
    calls: await f.manager.facts.list('calls'),
    count: f.requests.length,
  };
  await assert.rejects(
    f.manager.run(f.recipePath, { id: 'failed-summary', resume: true }),
    /receipt|unconfirmed|failed/i,
  );
  assert.equal(f.requests.length, before.count);
  assert.deepEqual(await f.manager.facts.list('calls'), before.calls);
});

test('independent timing instability retains the generated candidate and completed search; recovery adds no effects', async (t) => {
  const f = await setup(t, { markers: ['fixture:latency=8'] });
  const counter = join(f.root, 'worker-count');
  await writeFile(counter, '0');
  const worker = await readFile(f.worker, 'utf8');
  await writeFile(
    f.worker,
    worker.replace(
      'const latency = Number(',
      `const countPath = ${JSON.stringify(counter)};
const count = Number(await readFile(countPath, 'utf8'));
await writeFile(countPath, String(count + 1));
const latency = count === 2 ? 10 : Number(`,
    ),
  );
  const experiment = await f.manager.run(f.recipePath, {
    id: 'unstable-final',
  });
  const output = object(experiment.output);
  assert.equal(experiment.status, 'succeeded');
  assert.equal(output.finalValidity, 'valid');
  assert.equal(output.finalTimingStable, false);
  assert.equal(output.stopReason, 'accepted');
  assert.equal(
    (await f.manager.facts.read('candidates', string(output.bestCandidateRef)))
      .parentRef,
    object(experiment.application).initialCandidateRef,
  );
  assert.equal(await readFile(counter, 'utf8'), '3');
  const callsBefore = await f.manager.facts.list('calls');
  await f.manager.run(f.recipePath, { id: 'unstable-final', resume: true });
  assert.deepEqual(await f.manager.facts.list('calls'), callsBefore);
  assert.equal(await readFile(counter, 'utf8'), '3');
});

test('SDK infrastructure failure stops static search without being treated as a repairable candidate', async (t) => {
  const f = await setup(t, { markers: ['fixture:infrastructure'] });
  await assert.rejects(
    f.manager.run(f.recipePath, { id: 'infrastructure-stop' }),
  );
  assert.deepEqual(
    f.requests.map((r) => object(r.input).stage),
    ['diagnose', 'generate'],
  );
});

test('Manager stops operator search at the shared model budget and releases acquired instances', async (t) => {
  const f = await setup(t, {
    markers: ['fixture:latency=8'],
    budget: { modelCalls: 1 },
  });
  await assert.rejects(
    f.manager.run(f.recipePath, { id: 'model-budget' }),
    /budget/i,
  );
  const experiment = await f.manager.get('model-budget');
  assert.equal(experiment.status, 'failed');
  assert.equal(object(experiment.usage).modelCalls, 1);
  assert.equal(object(experiment.usage).evaluationRuns, 1);
  assert.ok(
    (await f.manager.facts.list('instances')).every(
      (instance) => instance.status === 'released',
    ),
  );
  const calls = await f.manager.facts.list('calls');
  await assert.rejects(
    f.manager.run(f.recipePath, { id: 'model-budget', resume: true }),
    /receipt|budget|failed/i,
  );
  assert.deepEqual(await f.manager.facts.list('calls'), calls);
});
