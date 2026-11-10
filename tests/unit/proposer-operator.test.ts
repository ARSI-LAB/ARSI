import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFile,
  writeFile,
  rm,
  copyFile,
  chmod,
  cp,
  mkdtemp,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createRuntime } from '../../src/runtime/context.js';
import {
  defineContract,
  agentContract,
  type RuntimeContext,
  type JsonObject,
  type AgentInput,
  type AgentOutput,
  type OperationDefinition,
  type OperatorProposerInput,
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { parseKernelExecution } from '../../src/plugins/application-kernel/schema.js';
import { loadOperatorTask } from '../../src/plugins/shared/operator-task.js';
import { prepareOperatorCase } from '../../src/plugins/evaluator-operatorbench/kernel-input.js';
import { adaptSdkResult } from '../../src/plugins/evaluator-operatorbench/result.js';
import { createOperatorProposer } from '../../src/plugins/proposer-operator/service.js';
import { readHistory } from '../../src/plugins/shared/operator-attempt/service.js';
import {
  configSchema,
  type OperatorProposerConfig,
} from '../../src/plugins/proposer-operator/schema.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { parseConfig } from '../../src/shared/schema.js';
import {
  prepareOperatorProposerFixture,
  operatorFixtureSource,
} from '../fixtures/operator-proposer/setup.js';

useOperatorSdkTestEnvironment();

type OperatorProject = {
  input: JsonObject;
  source: string;
  instructions: string;
};

async function setup(
  scenario: (
    context: RuntimeContext,
    requests: OperatorProject[],
  ) => Promise<JsonObject>,
  noIssues = false,
  options: {
    failSummary?: boolean;
    initialValid?: boolean;
    noChange?: boolean;
    sourcePath?: string;
    bundle?: boolean;
    outputSource?: string;
    outputReason?: string;
    metrics?: boolean;
    hardwareText?: string;
    invalidMetrics?: boolean;
    historyWindow?: number;
    invalidSummary?: boolean;
    promptsDirectory?: string;
    editRejection?: { stage: 'generate' | 'repair'; error: Error };
    invalidEdits?: 'generate' | 'repair';
  } = {},
) {
  const fixture = await prepareOperatorProposerFixture(options.sourcePath);
  if (options.bundle) {
    await writeFile(
      join(fixture.root, 'example/baseline/tiling.py'),
      'BLOCK = 32\n',
    );
    await writeFile(
      join(fixture.root, 'example/baseline/settings.json'),
      '{}\n',
    );
    await writeFile(
      join(fixture.root, 'example/target.yaml'),
      stringify({
        schemaVersion: 'rsi.target/v1',
        id: 'bundle',
        entries: [
          {
            path: 'tiling.py',
            kind: 'file',
            description: 'tiling',
            changes: ['modify'],
          },
        ],
      }),
    );
  }
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  const requests: OperatorProject[] = [];
  let generation = 0;
  const agent: OperationDefinition<AgentInput, AgentOutput, JsonObject> = {
    id: 'agent.operator-test',
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
            instructions: await readFile(
              join(request.cwd, 'AGENTS.md'),
              'utf8',
            ),
          });
          await context.charge('modelCalls', 1);
          const stage = input.stage;
          if (stage === 'diagnose-metrics')
            return options.invalidMetrics
              ? { invalid: true }
              : {
                  category: 'vector',
                  summary: 'Measured vector activity',
                  reasoning: 'Use the visible scalar work as one hypothesis',
                  rootCause: 'Scalar overhead is a hypothesis',
                  recommendedFix: 'Hoist invariant scalar work',
                  evidence: [
                    { path: '/kernels/0/metrics/0/aiv_vec_ratio', value: 0.7 },
                  ],
                };
          if (stage === 'diagnose')
            return {
              issues: noIssues
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
          if (stage === 'summarize' && options.invalidSummary)
            return { invalid: true };
          if (stage === 'summarize' && options.failSummary)
            throw new Error('Fixture summary model failed');
          if (stage === 'summarize')
            return {
              explanation: 'Observed attempt facts; cause remains a hypothesis',
              lessons: ['Use one hypothesis'],
              avoidPatterns: ['Previously measured change'],
              tryPatterns: ['Try another source-backed change'],
            };
          if (stage === options.editRejection?.stage) {
            await Promise.resolve();
            throw options.editRejection.error;
          }
          if (stage === options.invalidEdits) {
            await Promise.resolve();
            return {
              edits: [
                { path: 'input.py', content: 'unauthorized replacement' },
              ],
              reason: 'Invalid response',
            };
          }
          const marker =
            options.metrics && options.initialValid
              ? `fixture:latency=${9 - generation++}`
              : stage === 'repair'
                ? 'fixture:latency=12'
                : generation++ === 0 && !options.initialValid
                  ? 'fixture:incorrect'
                  : 'fixture:latency=8';
          return {
            edits: options.noChange
              ? []
              : [
                  {
                    path: options.bundle
                      ? 'tiling.py'
                      : string(input.sourcePath),
                    content:
                      options.outputSource ??
                      (options.bundle
                        ? 'BLOCK = 64\n'
                        : operatorFixtureSource(marker)),
                  },
                ],
            reason: options.outputReason ?? `Changed ${marker}`,
          };
        },
        async dispose() {},
      };
    },
  };
  runtime.registry.registerOperation(agent);
  const driverContract = defineContract({
    id: 'contract.operator-driver',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  });
  runtime.registry.registerOperation({
    id: 'operator.driver',
    contract: driverContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(_input, context) {
          return scenario(context, requests);
        },
        async dispose() {},
      };
    },
  });
  const policyPath = join(fixture.root, 'policy.yaml');
  await writeFile(
    policyPath,
    stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'test.operator-driver',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        driver: { contract: 'contract.operator-driver' },
        evaluator: { contract: 'contract.operatorbench' },
        selector: { contract: 'contract.selector-metrics' },
        proposer: { contract: 'contract.proposer-operator' },
        summarizer: { contract: 'contract.summarizer-operator' },
        agent: { contract: 'contract.agent' },
      },
      state_schema: { type: 'object', additionalProperties: false },
      state: {},
      steps: [{ id: 'run', type: 'invoke', use: 'driver', with: {} }],
      output: '${{ steps.run.output }}',
    }),
  );
  runtime.registry.registerPolicy('test.operator-driver', policyPath);
  const recipe = object(parse(await readFile(fixture.recipePath, 'utf8')));
  recipe.policy = { id: 'test.operator-driver' };
  const bindings = object(recipe.bindings);
  bindings.driver = { plugin: 'operator.driver', config: {} };
  bindings.agent = { plugin: agent.id, config: {} };
  bindings.summarizer = {
    plugin: 'summarizer.operator',
    config: {
      agentRef: 'agent',
      promptFile: fileURLToPath(
        new URL(
          '../../src/policies/operator-search/prompts/summarize.md',
          import.meta.url,
        ),
      ),
    },
  };
  bindings.proposer = {
    plugin: 'proposer.operator',
    config: {
      agentRef: 'agent',
      promptsDirectory:
        options.promptsDirectory ??
        fileURLToPath(
          new URL(
            '../../src/policies/operator-search/prompts/',
            import.meta.url,
          ),
        ),
      task: { directory: join(fixture.root, 'example/task') },
      embedding: {
        python: fixture.embeddingPython,
        resourcesDirectory: fixture.resourcesDirectory,
        retrievalScript: fixture.retrievalScript,
        modelDirectory: fixture.modelDirectory,
        identityFile: fixture.identityFile,
      },
    },
  };
  if (options.historyWindow !== undefined)
    object(object(bindings.proposer).config).historyWindow =
      options.historyWindow;
  if (options.metrics) {
    const msprof = join(fixture.root, 'msprof.mjs');
    await copyFile(
      new URL('../fixtures/operator-sdk/msprof.mjs', import.meta.url),
      msprof,
    );
    await chmod(msprof, 0o755);
    const evaluator = object(object(bindings.evaluator).config);
    object(object(evaluator.benchmark).config).profiling = {
      enabled: false,
      cacheEnabled: false,
      warmup: 25,
      msprofBin: msprof,
      maxAttempts: 1,
      attemptTimeoutSeconds: 10,
    };
  }
  if (options.hardwareText !== undefined) {
    const hardware = join(fixture.root, 'hardware-context.md');
    await writeFile(hardware, options.hardwareText);
    object(object(bindings.proposer).config).hardwareContextFile = hardware;
  }
  recipe.budget = {
    operations: 256,
    evaluationRuns: 14,
    modelCalls: 32,
    elapsedWallMs: 2400000,
    cleanupReserveMs: 60000,
  };
  await writeFile(fixture.recipePath, stringify(recipe));
  return {
    ...fixture,
    runtime,
    requests,
    async dispose() {
      await runtime.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    },
  };
}

async function baseline(context: RuntimeContext) {
  const entry = string(
    (await context.applicationMetadata()).initialCandidateRef,
  );
  const evaluated = object(
    await context.invoke('evaluator', {
      action: 'evaluate',
      candidateRef: entry,
      caseIds: ['fixed'],
    }),
  );
  return { entry, baselineRef: string(evaluated.measurementRef) };
}

test('operator reads the declared bundle and edits a helper while the entry stays read-only', async (t) => {
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const proposal = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Optimize tiling',
          analysisRef: null,
          historyRef: null,
        }),
      );
      assert.equal(proposal.status, 'created');
      assert.deepEqual(requests.at(-1)?.input.editablePaths, ['tiling.py']);
      assert.deepEqual(requests.at(-1)?.input.sourceFiles, [
        'input.py',
        'settings.json',
        'tiling.py',
      ]);
      const candidate = await context.readCandidate(
        string(proposal.candidateRef),
      );
      const space = await context.workspaces.create(candidate.artifactRef);
      try {
        assert.equal(
          await readFile(join(space.directory, 'input.py'), 'utf8'),
          fixture.entrySource,
        );
        assert.equal(
          await readFile(join(space.directory, 'tiling.py'), 'utf8'),
          'BLOCK = 64\n',
        );
      } finally {
        await context.workspaces.release(space.ref);
      }
      return proposal;
    },
    false,
    { bundle: true, initialValid: true },
  );
  t.after(() => fixture.dispose());
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'operator-bundle',
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
});

test('helper-only candidates retain comparison conditions and profile the matching bundle', async (t) => {
  const fixture = await setup(
    async (context) => {
      const { entry, baselineRef } = await baseline(context);
      const proposal = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Tune helper',
          analysisRef: null,
          historyRef: null,
        }),
      );
      const candidateRef = string(proposal.candidateRef);
      const evaluated = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const before = await context.readMeasurement(baselineRef);
      const after = await context.readMeasurement(
        string(evaluated.measurementRef),
      );
      assert.equal(before.comparisonKey, after.comparisonKey);
      const provenance = async (measurement: JsonObject) =>
        object(
          await context.artifacts.readJson(
            string(object(measurement.provenance).artifactRef),
          ),
        );
      const original = await provenance(before);
      const changed = await provenance(after);
      assert.equal(original.sourceDigest, changed.sourceDigest);
      assert.notEqual(original.sourceBundleDigest, changed.sourceBundleDigest);
      const native = object(
        await context.artifacts.readJson(string(after.diagnosticsRef)),
      );
      await context.withInstance(candidateRef, 'kernel-source', async (raw) => {
        const prepared = await prepareOperatorCase({
          task: await loadOperatorTask(join(fixture.root, 'example/task')),
          selected: { id: 'fixed', seed: 42 },
          execution: parseKernelExecution(raw),
          manifest: join(context.directory, 'lock-check/manifest.json'),
          operation: 'evaluate',
          editablePaths: ['tiling.py'],
        });
        const altered = structuredClone(native);
        const files = object(object(object(altered.snapshot).run).source).files;
        assert.ok(Array.isArray(files));
        const helper = files
          .map((value) => object(value))
          .find((file) => file.path === 'data/candidate/tiling.py');
        assert.ok(helper);
        helper.sha256 = '0'.repeat(64);
        assert.throws(
          () => adaptSdkResult(altered, prepared),
          /source inventory identity mismatch/,
        );
      });
      const profiled = object(
        await context.invoke('evaluator', {
          action: 'profile',
          candidateRef,
          caseIds: ['fixed'],
          assessmentMeasurementRef: after.ref,
        }),
      );
      assert.equal(profiled.collectionStatus, 'completed');
      const measurement = await context.readMeasurement(
        string(profiled.measurementRef),
      );
      const details = object(
        await context.artifacts.readJson(
          string(object(measurement.profile).artifactRef),
        ),
      );
      assert.equal(details.sourceBundleDigest, changed.sourceBundleDigest);
      const members = object(
        object(object(details.profile).metadata).sources,
      ).candidateFiles;
      assert.ok(Array.isArray(members));
      assert.deepEqual(
        members.map((value) => object(value).path),
        ['input.py', 'settings.json', 'tiling.py'],
      );
      assert.equal(
        object(members[2]).sha256,
        createHash('sha256').update('BLOCK = 64\n').digest('hex'),
      );
      return proposal;
    },
    false,
    { bundle: true, initialValid: true, metrics: true },
  );
  t.after(() => fixture.dispose());
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'bundle-profile',
  });
  assert.equal(result.status, 'succeeded');
});

test('standalone summaries preserve the complete rationale after proposal resources become unavailable', async (t) => {
  const promptsDirectory = await mkdtemp(
    join(tmpdir(), 'summary-without-proposer-'),
  );
  t.after(() => rm(promptsDirectory, { recursive: true, force: true }));
  await cp(
    new URL('../../src/policies/operator-search/prompts/', import.meta.url),
    promptsDirectory,
    { recursive: true },
  );
  const rationale =
    'Detailed invariant evidence. '.repeat(200) + 'Final rationale detail.';
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const proposal = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Preserve all supported rationale',
          analysisRef: null,
          historyRef: null,
        }),
      );
      assert.equal(proposal.status, 'no-change');
      await rm(join(promptsDirectory, 'generate.md'));
      await rm(fixture.resourcesDirectory, { recursive: true });
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [proposal],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: proposal.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [entry],
          measurementRefs: [],
          decisionRef: null,
          outcome: 'no-change',
        }),
      );
      const history = await readHistory(string(summary.historyRef), context);
      assert.equal(history.summaries[0]!.actionSummary, rationale);
      const summaryRequest = requests.find(
        (request) => object(request.input).stage === 'summarize',
      )!;
      assert.equal(object(summaryRequest.input).actionSummary, rationale);
      return summary;
    },
    false,
    { noChange: true, outputReason: rationale, promptsDirectory },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'complete-static-rationale',
      })
    ).status,
    'succeeded',
  );
});

test('the summarizer rejects a measurement belonging to the parent instead of the proposed candidate', async (t) => {
  const fixture = await setup(async (context) => {
    const { entry, baselineRef } = await baseline(context);
    const proposal = object(
      await context.invoke('proposer', {
        action: 'propose',
        phase: 'static',
        entryCandidateRef: entry,
        baselineMeasurementRef: baselineRef,
        analysisRef: null,
        historyRef: null,
        attempt: 1,
        goal: 'Optimize',
      }),
    );
    assert.equal(proposal.status, 'created');
    return object(
      await context.invoke('summarizer', {
        action: 'summarize',
        actions: [proposal],
        phase: 'static',
        entryCandidateRef: entry,
        analysisRef: proposal.analysisRef,
        historyRef: null,
        attempt: 1,
        candidateRefs: [proposal.candidateRef],
        measurementRefs: [baselineRef],
        decisionRef: null,
        outcome: 'verification-failed',
      }),
    );
  });
  t.after(() => fixture.dispose());
  await assert.rejects(
    fixture.runtime.manager.run(fixture.recipePath, {
      id: 'foreign-assessment',
    }),
    /assessment candidate, source or cleanup mismatch/,
  );
  assert.ok(
    fixture.requests.every((request) => request.input.stage !== 'summarize'),
  );
});

test('operator generation receives configured prompts and rejects analysis after prompt changes', async (t) => {
  const promptsDirectory = await mkdtemp(join(tmpdir(), 'operator-prompts-'));
  t.after(() => rm(promptsDirectory, { recursive: true, force: true }));
  await cp(
    new URL('../../src/policies/operator-search/prompts/', import.meta.url),
    promptsDirectory,
    { recursive: true },
  );
  const generate = join(promptsDirectory, 'generate.md');
  await writeFile(generate, 'Configured generation sentinel\n');
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const input: OperatorProposerInput = {
        action: 'propose',
        phase: 'static',
        entryCandidateRef: entry,
        baselineMeasurementRef: baselineRef,
        attempt: 1,
        goal: 'Use configured prompts',
        analysisRef: null,
        historyRef: null,
      };
      const first = object(await context.invoke('proposer', input));
      assert.equal(first.status, 'created');
      assert.ok(
        requests[1]!.instructions.startsWith(
          'Configured generation sentinel\n',
        ),
      );
      await writeFile(generate, 'Changed generation sentinel\n');
      const configured = await Recipe.load(
        fixture.recipePath,
        fixture.runtime.registry,
      );
      const operation = await createOperatorProposer(
        parseConfig<OperatorProposerConfig>(
          configSchema,
          configured.bindings.proposer!.config,
        ),
        context,
      );
      try {
        await assert.rejects(
          operation.execute(
            { ...input, analysisRef: string(first.analysisRef) },
            context,
          ),
          /identity.*mismatch/i,
        );
      } finally {
        await operation.dispose();
      }
      assert.equal(requests.length, 2);
      return first;
    },
    false,
    { initialValid: true, promptsDirectory },
  );
  t.after(() => fixture.dispose());
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'configured-prompts',
  });
  assert.equal(result.status, 'succeeded');
});

test('operator Proposer repairs a failed multi-file candidate and delivers the measured summary to a fresh entry proposal', async (t) => {
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const first = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Optimize',
          analysisRef: null,
          historyRef: null,
        }),
      );
      assert.equal(first.status, 'created');
      const failed = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: first.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const repaired = object(
        await context.invoke('proposer', {
          action: 'repair',
          phase: 'static',
          failedCandidateRef: first.candidateRef,
          measurementRef: failed.measurementRef,
          analysisRef: first.analysisRef,
          historyRef: null,
          attempt: 1,
          repairIndex: 1,
          goal: 'Repair',
        }),
      );
      const measured = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: repaired.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const decision = object(
        await context.invoke('selector', {
          incumbentMeasurementRef: baselineRef,
          candidateMeasurementRef: measured.measurementRef,
        }),
      );
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [first, repaired],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: first.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [first.candidateRef, repaired.candidateRef],
          measurementRefs: [failed.measurementRef, measured.measurementRef],
          decisionRef: decision.decisionRef,
          outcome: 'verified-no-gain',
        }),
      );
      const history = await readHistory(string(summary.historyRef), context);
      assert.equal(history.summaries[0]!.facts.candidateMs, 12);
      const next = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 2,
          goal: 'Optimize differently',
          analysisRef: first.analysisRef,
          historyRef: summary.historyRef,
        }),
      );
      assert.equal(next.status, 'created');
      assert.deepEqual(
        requests.map((request) => object(request.input).stage),
        ['diagnose', 'generate', 'repair', 'summarize', 'generate'],
      );
      const nextInput = object(requests[4]!.input);
      assert.match(JSON.stringify(nextInput.history), /Use one hypothesis/);
      assert.match(JSON.stringify(nextInput.history), /candidateMs.*12/);
      assert.equal(
        requests[4]!.source,
        operatorFixtureSource('fixture:latency=10'),
      );
      assert.equal(
        requests[2]!.source,
        operatorFixtureSource('fixture:incorrect'),
      );
      assert.match(
        JSON.stringify(object(requests[2]!.input).evidence),
        /KERNEL_CONTRACT_FAILED/,
      );
      const child = await context.readCandidate(string(next.candidateRef));
      assert.equal(child.parentRef, entry);
      for (const request of requests) {
        assert.equal(request.input.sourcePath, 'kernels/transpose[0].py');
        assert.deepEqual(request.input.sourceFiles, [
          'kernels/constants.py',
          'kernels/transpose[0].py',
        ]);
      }
      return { ...next, historyRef: summary.historyRef };
    },
    false,
    { sourcePath: 'kernels/transpose[0].py' },
  );
  t.after(() => fixture.dispose());
  await writeFile(
    join(fixture.root, 'example/baseline/kernels/constants.py'),
    'BLOCK = 32\n',
  );
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'operator-actions',
  });
  assert.equal(result.status, 'succeeded');
  const before = {
    calls: await fixture.runtime.manager.facts.list('calls'),
    usage: result.usage,
  };
  const resumed = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'operator-actions',
    resume: true,
  });
  assert.deepEqual(resumed.usage, before.usage);
  assert.deepEqual(
    await fixture.runtime.manager.facts.list('calls'),
    before.calls,
  );
  assert.equal(fixture.requests.length, 5);
});

test('valid empty static diagnosis skips retrieval and candidate generation', async (t) => {
  const fixture = await setup(async (context, requests) => {
    const { entry, baselineRef } = await baseline(context);
    const output = object(
      await context.invoke('proposer', {
        action: 'propose',
        phase: 'static',
        entryCandidateRef: entry,
        baselineMeasurementRef: baselineRef,
        attempt: 1,
        goal: 'Inspect',
        analysisRef: null,
        historyRef: null,
      }),
    );
    assert.equal(output.status, 'no-change');
    assert.equal(output.reasonCode, 'no-static-issues');
    assert.equal(output.candidateRef, entry);
    assert.equal(requests.length, 1);
    return output;
  }, true);
  t.after(() => fixture.dispose());
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'operator-empty',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(object(result.usage).modelCalls, 1);
  assert.equal(object(result.usage).evaluationRuns, 1);
});

test('operator summary model failure preserves completed effects and blocks replay of the unfinished action', async (t) => {
  const fixture = await setup(
    async (context) => {
      const { entry, baselineRef } = await baseline(context);
      const proposed = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Optimize',
          analysisRef: null,
          historyRef: null,
        }),
      );
      const evaluated = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: proposed.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const decision = object(
        await context.invoke('selector', {
          incumbentMeasurementRef: baselineRef,
          candidateMeasurementRef: evaluated.measurementRef,
        }),
      );
      return object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [proposed],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: proposed.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [proposed.candidateRef],
          measurementRefs: [evaluated.measurementRef],
          decisionRef: decision.decisionRef,
          outcome: 'adopted',
        }),
      );
    },
    false,
    { failSummary: true, initialValid: true },
  );
  t.after(() => fixture.dispose());
  await assert.rejects(
    fixture.runtime.manager.run(fixture.recipePath, {
      id: 'operator-summary-failed',
    }),
    /summary model failed/,
  );
  const before = {
    calls: await fixture.runtime.manager.facts.list('calls'),
    measurements: await fixture.runtime.manager.facts.list('measurements'),
    requests: fixture.requests.length,
  };
  assert.equal(before.measurements.length, 2);
  await assert.rejects(
    fixture.runtime.manager.run(fixture.recipePath, {
      id: 'operator-summary-failed',
      resume: true,
    }),
    /receipt|unconfirmed|failed/i,
  );
  assert.equal(fixture.requests.length, before.requests);
  assert.deepEqual(
    await fixture.runtime.manager.facts.list('calls'),
    before.calls,
  );
});

test('metric Proposer executes two rounds with measured diagnostics, current best parents and delivered hardware/history', async (t) => {
  const hardwareText =
    '# User hardware\r\nOnly these provided facts are allowed.  \r\n';
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      let parent = entry,
        incumbent = baselineRef,
        historyRef = null;
      let diagnostic = string(
        object(
          await context.invoke('evaluator', {
            action: 'profile',
            candidateRef: parent,
            caseIds: ['fixed'],
            assessmentMeasurementRef: incumbent,
          }),
        ).measurementRef,
      );
      for (let round = 1; round <= 2; round++) {
        const proposed = object(
          await context.invoke('proposer', {
            action: 'propose',
            phase: 'metrics',
            parentCandidateRef: parent,
            incumbentMeasurementRef: incumbent,
            diagnosticMeasurementRef: diagnostic,
            round,
            historyRef,
            staticHistoryRef: null,
            goal: 'Optimize measured activity',
          }),
        );
        assert.equal(proposed.status, 'created');
        const assessed = object(
          await context.invoke('evaluator', {
            action: 'evaluate',
            candidateRef: proposed.candidateRef,
            caseIds: ['fixed'],
          }),
        );
        const selected = object(
          await context.invoke('selector', {
            incumbentMeasurementRef: incumbent,
            candidateMeasurementRef: assessed.measurementRef,
          }),
        );
        assert.equal(selected.accepted, true);
        const nextProfile = object(
          await context.invoke('evaluator', {
            action: 'profile',
            candidateRef: proposed.candidateRef,
            caseIds: ['fixed'],
            assessmentMeasurementRef: assessed.measurementRef,
          }),
        );
        const summarized = object(
          await context.invoke('summarizer', {
            action: 'summarize',
            actions: [proposed],
            phase: 'metrics',
            parentCandidateRef: parent,
            incumbentMeasurementRef: incumbent,
            analysisRef: proposed.analysisRef,
            round,
            historyRef,
            candidateRefs: [proposed.candidateRef],
            measurementRefs: [assessed.measurementRef],
            decisionRef: selected.decisionRef,
            candidateDiagnosticMeasurementRef: nextProfile.measurementRef,
            outcome: 'adopted',
          }),
        );
        historyRef = string(summarized.historyRef);
        parent = string(proposed.candidateRef);
        incumbent = string(assessed.measurementRef);
        diagnostic = string(nextProfile.measurementRef);
      }
      const generates = requests.filter(
        (request) => object(request.input).stage === 'generate',
      );
      const analyses = requests.filter(
        (request) => object(request.input).stage === 'diagnose-metrics',
      );
      const summaries = requests.filter(
        (request) => request.input.stage === 'summarize',
      );
      assert.equal(summaries.length, 2);
      for (const { input } of summaries) {
        assert.equal(input.history, undefined);
        assert.equal(input.staticHistory, undefined);
      }
      assert.equal(generates.length, 2);
      assert.equal(analyses.length, 2);
      assert.equal(object(generates[0]!.input).hardwareContext, hardwareText);
      assert.equal(object(generates[1]!.input).hardwareContext, hardwareText);
      assert.equal(object(analyses[0]!.input).hardwareContext, hardwareText);
      assert.deepEqual(object(generates[0]!.input).history, []);
      assert.match(
        JSON.stringify(object(generates[1]!.input).history),
        /candidateMs.*9/,
      );
      assert.equal(
        generates[1]!.source,
        operatorFixtureSource('fixture:latency=9'),
      );
      return { parent, historyRef };
    },
    false,
    { metrics: true, initialValid: true, hardwareText },
  );
  t.after(() => fixture.dispose());
  const result = await fixture.runtime.manager.run(fixture.recipePath, {
    id: 'metrics-two-rounds',
  });
  assert.equal(result.status, 'succeeded');
});

test('metric repairs use the failed candidate and deliver the complete user hardware document', async (t) => {
  const hardwareText = '# Hardware\nUser-provided capacity context.\n';
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const diagnostic = object(
        await context.invoke('evaluator', {
          action: 'profile',
          candidateRef: entry,
          caseIds: ['fixed'],
          assessmentMeasurementRef: baselineRef,
        }),
      );
      const proposed = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'metrics',
          parentCandidateRef: entry,
          incumbentMeasurementRef: baselineRef,
          diagnosticMeasurementRef: diagnostic.measurementRef,
          round: 1,
          historyRef: null,
          staticHistoryRef: null,
          goal: 'Optimize the measured bottleneck',
        }),
      );
      const failed = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: proposed.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const repaired = object(
        await context.invoke('proposer', {
          action: 'repair',
          phase: 'metrics',
          failedCandidateRef: proposed.candidateRef,
          measurementRef: failed.measurementRef,
          analysisRef: proposed.analysisRef,
          round: 1,
          repairIndex: 1,
          historyRef: null,
          staticHistoryRef: null,
          goal: 'Repair the numerical defect',
        }),
      );
      assert.equal(repaired.status, 'created');
      const repairRequest = requests.find(
        (request) => object(request.input).stage === 'repair',
      );
      assert.ok(repairRequest);
      assert.equal(
        repairRequest.source,
        operatorFixtureSource('fixture:incorrect'),
      );
      assert.equal(object(repairRequest.input).hardwareContext, hardwareText);
      const assessed = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: repaired.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const selection = object(
        await context.invoke('selector', {
          incumbentMeasurementRef: baselineRef,
          candidateMeasurementRef: assessed.measurementRef,
        }),
      );
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [proposed, repaired],
          phase: 'metrics',
          parentCandidateRef: entry,
          incumbentMeasurementRef: baselineRef,
          analysisRef: proposed.analysisRef,
          round: 1,
          historyRef: null,
          candidateRefs: [proposed.candidateRef, repaired.candidateRef],
          measurementRefs: [failed.measurementRef, assessed.measurementRef],
          decisionRef: selection.decisionRef,
          candidateDiagnosticMeasurementRef: null,
          outcome: 'verified-no-gain',
        }),
      );
      const summaryRequest = requests.find(
        (request) => object(request.input).stage === 'summarize',
      );
      assert.ok(summaryRequest);
      assert.match(
        JSON.stringify(object(summaryRequest.input).actions),
        /Changed fixture:latency=12/,
      );
      assert.match(
        JSON.stringify(object(summaryRequest.input).evidence),
        /KERNEL_CONTRACT_FAILED/,
      );
      return summary;
    },
    false,
    { metrics: true, hardwareText },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'metric-repair',
      })
    ).status,
    'succeeded',
  );
});

test('invalid metric analysis rereads fact history through twelve rounds beyond former ceilings', async (t) => {
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const diagnostic = object(
        await context.invoke('evaluator', {
          action: 'profile',
          candidateRef: entry,
          caseIds: ['fixed'],
          assessmentMeasurementRef: baselineRef,
        }),
      );
      let historyRef = null;
      for (let round = 1; round <= 12; round++) {
        const result = object(
          await context.invoke('proposer', {
            action: 'propose',
            phase: 'metrics',
            parentCandidateRef: entry,
            incumbentMeasurementRef: baselineRef,
            diagnosticMeasurementRef: diagnostic.measurementRef,
            round,
            historyRef,
            staticHistoryRef: null,
            goal: 'Analyze the measured profile',
          }),
        );
        assert.equal(result.status, 'failed');
        assert.equal(result.candidateRef, entry);
        assert.equal(
          object(await context.artifacts.readJson(string(result.errorRef)))
            .phase,
          'metrics',
        );
        const summary = object(
          await context.invoke('summarizer', {
            action: 'summarize',
            actions: [result],
            phase: 'metrics',
            parentCandidateRef: entry,
            incumbentMeasurementRef: baselineRef,
            analysisRef: result.analysisRef,
            round,
            historyRef,
            candidateRefs: [],
            measurementRefs: [],
            decisionRef: null,
            candidateDiagnosticMeasurementRef: null,
            outcome: 'proposal-failed',
          }),
        );
        historyRef = string(summary.historyRef);
      }
      assert.equal(
        requests.some((request) => object(request.input).stage === 'generate'),
        false,
      );
      assert.equal(
        requests.filter(
          (request) => object(request.input).stage === 'diagnose-metrics',
        ).length,
        12,
      );
      for (const request of requests.filter(
        (r) => object(r.input).stage === 'diagnose-metrics',
      ))
        assert.deepEqual(object(request.input).history, []);
      const history = object(await context.artifacts.readJson(historyRef!));
      assert.equal((history.summaryRefs as string[]).length, 12);
      return { historyRef };
    },
    false,
    { metrics: true, invalidMetrics: true, historyWindow: 0 },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'metric-analysis-failure',
      })
    ).status,
    'succeeded',
  );
});

test('operator source bytes follow the explicit Application Target rather than a proposer ceiling', async (t) => {
  const outputSource =
    operatorFixtureSource('fixture:latency=8') + `# ${'€'.repeat(12000)}\n`;
  for (const permitted of [true, false]) {
    const fixture = await setup(
      async (context) => {
        const { entry, baselineRef } = await baseline(context);
        return object(
          await context.invoke('proposer', {
            action: 'propose',
            phase: 'static',
            entryCandidateRef: entry,
            baselineMeasurementRef: baselineRef,
            attempt: 1,
            goal: 'Apply the complete authorized source',
            analysisRef: null,
            historyRef: null,
          }),
        );
      },
      false,
      { initialValid: true, outputSource },
    );
    t.after(() => fixture.dispose());
    if (permitted) {
      const targetPath = join(fixture.root, 'example/target.yaml');
      const target = object(parse(await readFile(targetPath, 'utf8')));
      object(object((target.entries as JsonObject[])[0]).content).maxBytes =
        65536;
      object(target.constraints).maxChangedBytes = 65536;
      await writeFile(targetPath, stringify(target));
      const result = await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'large-source-permitted',
      });
      assert.equal(object(result.output).status, 'created');
      const candidate = await fixture.runtime.manager.facts.read(
        'candidates',
        string(object(result.output).candidateRef),
      );
      const tree = object(
        await fixture.runtime.manager.artifacts.readJson(
          string(candidate.artifactRef),
        ),
      );
      assert.equal(
        Buffer.from(
          string(object((tree.files as JsonObject[])[0]).base64),
          'base64',
        ).toString('utf8'),
        outputSource,
      );
    } else {
      await assert.rejects(
        fixture.runtime.manager.run(fixture.recipePath, {
          id: 'large-source-rejected',
        }),
        /content|size|bytes/i,
      );
    }
  }
});

test('invalid static summary output preserves a fact-only summary with an explicit unavailable status', async (t) => {
  const fixture = await setup(
    async (context) => {
      const { entry, baselineRef } = await baseline(context);
      const proposal = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'One supported change',
          analysisRef: null,
          historyRef: null,
        }),
      );
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [proposal],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: proposal.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [entry],
          measurementRefs: [],
          decisionRef: null,
          outcome: 'no-change',
        }),
      );
      const record = object(
        await context.artifacts.readJson(string(summary.summaryRef)),
      );
      assert.equal(record.summaryStatus, 'unavailable');
      assert.equal(object(record.facts).accepted, false);
      assert.deepEqual(record.lessons, []);
      return summary;
    },
    false,
    { noChange: true, invalidSummary: true },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'invalid-static-summary',
      })
    ).status,
    'succeeded',
  );
});

for (const abortAt of ['summary', 'history'] as const)
  test(`cancelling while writing ${abortAt} artifacts keeps the summary call cancelled`, async (t) => {
    const controller = new AbortController();
    const writes: string[] = [];
    const fixture = await setup(
      async (context) => {
        const { entry, baselineRef } = await baseline(context);
        const proposal = object(
          await context.invoke('proposer', {
            action: 'propose',
            phase: 'static',
            entryCandidateRef: entry,
            baselineMeasurementRef: baselineRef,
            attempt: 1,
            goal: 'Keep the unchanged candidate',
            analysisRef: null,
            historyRef: null,
          }),
        );
        const artifacts = context.artifacts;
        const putJson = artifacts.putJson;
        artifacts.putJson = async (value) => {
          const ref = await putJson.call(artifacts, value);
          const version = object(value).schemaVersion;
          const kind =
            version === 'rsi.operator-summary/v1'
              ? 'summary'
              : version === 'rsi.operator-history/v1'
                ? 'history'
                : null;
          if (kind !== null) writes.push(kind);
          if (kind === abortAt)
            controller.abort(new Error('Cancelled during summary persistence'));
          return ref;
        };
        try {
          return object(
            await context.invoke('summarizer', {
              action: 'summarize',
              actions: [proposal],
              phase: 'static',
              entryCandidateRef: entry,
              analysisRef: proposal.analysisRef,
              historyRef: null,
              attempt: 1,
              candidateRefs: [entry],
              measurementRefs: [],
              decisionRef: null,
              outcome: 'no-change',
            }),
          );
        } finally {
          artifacts.putJson = putJson;
        }
      },
      false,
      { noChange: true },
    );
    t.after(() => fixture.dispose());
    await assert.rejects(
      fixture.runtime.manager.run(fixture.recipePath, {
        id: `cancel-${abortAt}-persistence`,
        signal: controller.signal,
      }),
      /Cancelled during summary persistence/,
    );
    const calls = await fixture.runtime.manager.facts.list('calls');
    const summarized = calls.filter(
      (call) =>
        call.pluginId === 'summarizer.operator' &&
        object(call.input).action === 'summarize',
    );
    assert.equal(summarized.length, 1);
    assert.equal(summarized[0]!.status, 'cancelled');
    assert.deepEqual(
      writes,
      abortAt === 'summary' ? ['summary'] : ['summary', 'history'],
    );
  });

test('asynchronous invalid generation retains error evidence and history for the next static attempt', async (t) => {
  const fixture = await setup(
    async (context, requests) => {
      const { entry, baselineRef } = await baseline(context);
      const first = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Optimize',
          analysisRef: null,
          historyRef: null,
        }),
      );
      assert.equal(first.status, 'failed');
      assert.equal(first.reasonCode, 'invalid-model-output');
      assert.equal(first.candidateRef, entry);
      assert.equal(first.diffRef, null);
      const error = object(
        await context.artifacts.readJson(string(first.errorRef)),
      );
      assert.equal(error.stage, 'propose');
      assert.equal(error.phase, 'static');
      assert.equal(error.attempt, 1);
      assert.match(
        string(error.message),
        /edits\/0\/path must be equal to one of the allowed values/,
      );
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [first],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: first.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [entry],
          measurementRefs: [],
          decisionRef: null,
          outcome: 'proposal-failed',
        }),
      );
      const history = await readHistory(string(summary.historyRef), context);
      assert.equal(history.summaries[0]!.facts.outcome, 'proposal-failed');
      assert.equal(history.summaries[0]!.facts.wasTransformCorrect, null);
      const next = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 2,
          goal: 'Optimize differently',
          analysisRef: first.analysisRef,
          historyRef: summary.historyRef,
        }),
      );
      assert.equal(next.status, 'failed');
      assert.equal(
        object(await context.artifacts.readJson(string(next.errorRef))).attempt,
        2,
      );
      assert.deepEqual(
        requests.map((request) => object(request.input).stage),
        ['diagnose', 'generate', 'summarize', 'generate'],
      );
      assert.match(
        JSON.stringify(object(requests.at(-1)!.input).history),
        /proposal-failed/,
      );
      return next;
    },
    false,
    { invalidEdits: 'generate', sourcePath: 'kernels/transpose.py' },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'async-invalid-generation',
      })
    ).status,
    'succeeded',
  );
});

test('asynchronous invalid repair retains the failed source and repair error without losing the measured history', async (t) => {
  const fixture = await setup(
    async (context) => {
      const { entry, baselineRef } = await baseline(context);
      const first = object(
        await context.invoke('proposer', {
          action: 'propose',
          phase: 'static',
          entryCandidateRef: entry,
          baselineMeasurementRef: baselineRef,
          attempt: 1,
          goal: 'Optimize',
          analysisRef: null,
          historyRef: null,
        }),
      );
      const measured = object(
        await context.invoke('evaluator', {
          action: 'evaluate',
          candidateRef: first.candidateRef,
          caseIds: ['fixed'],
        }),
      );
      const repair = object(
        await context.invoke('proposer', {
          action: 'repair',
          phase: 'static',
          failedCandidateRef: first.candidateRef,
          measurementRef: measured.measurementRef,
          analysisRef: first.analysisRef,
          historyRef: null,
          attempt: 1,
          repairIndex: 1,
          goal: 'Repair',
        }),
      );
      assert.equal(repair.status, 'failed');
      assert.equal(repair.reasonCode, 'invalid-model-output');
      assert.equal(repair.candidateRef, first.candidateRef);
      assert.equal(repair.analysisRef, first.analysisRef);
      const error = object(
        await context.artifacts.readJson(string(repair.errorRef)),
      );
      assert.equal(error.stage, 'repair');
      assert.equal(error.phase, 'static');
      const summary = object(
        await context.invoke('summarizer', {
          action: 'summarize',
          actions: [first, repair],
          phase: 'static',
          entryCandidateRef: entry,
          analysisRef: first.analysisRef,
          historyRef: null,
          attempt: 1,
          candidateRefs: [first.candidateRef],
          measurementRefs: [measured.measurementRef],
          decisionRef: null,
          outcome: 'verification-failed',
        }),
      );
      const history = await readHistory(string(summary.historyRef), context);
      assert.equal(history.summaries[0]!.facts.wasTransformCorrect, false);
      return summary;
    },
    false,
    { invalidEdits: 'repair', sourcePath: 'kernels/transpose.py' },
  );
  t.after(() => fixture.dispose());
  assert.equal(
    (
      await fixture.runtime.manager.run(fixture.recipePath, {
        id: 'async-invalid-repair',
      })
    ).status,
    'succeeded',
  );
});

for (const [label, error] of [
  ['infrastructure', new Error('Fixture model transport failed')],
  ['abort', new DOMException('Fixture model request cancelled', 'AbortError')],
] as const) {
  test(`asynchronous generation ${label} failure remains fatal`, async (t) => {
    const fixture = await setup(
      async (context) => {
        const { entry, baselineRef } = await baseline(context);
        return object(
          await context.invoke('proposer', {
            action: 'propose',
            phase: 'static',
            entryCandidateRef: entry,
            baselineMeasurementRef: baselineRef,
            attempt: 1,
            goal: 'Optimize',
            analysisRef: null,
            historyRef: null,
          }),
        );
      },
      false,
      { editRejection: { stage: 'generate', error } },
    );
    t.after(() => fixture.dispose());
    await assert.rejects(
      fixture.runtime.manager.run(fixture.recipePath, {
        id: `async-fatal-${label}`,
      }),
      (failure: unknown) =>
        failure instanceof Error && failure.message.includes(error.message),
    );
  });
}
