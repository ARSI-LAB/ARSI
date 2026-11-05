import { useOperatorSdkTestEnvironment } from '../fixtures/operator-sdk/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
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
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { operatorProposerDefinition } from '../../src/plugins/proposer-operator/index.js';
import { readHistory } from '../../src/plugins/proposer-operator/context.js';
import {
  prepareOperatorProposerFixture,
  operatorFixtureSource,
} from '../fixtures/operator-proposer/setup.js';

useOperatorSdkTestEnvironment();

async function setup(
  scenario: (
    context: RuntimeContext,
    requests: AgentInput[],
  ) => Promise<JsonObject>,
  noIssues = false,
  options: {
    failSummary?: boolean;
    initialValid?: boolean;
    noChange?: boolean;
    metrics?: boolean;
    hardwareText?: string;
    invalidMetrics?: boolean;
    invalidSummary?: boolean;
    editRejection?: { stage: 'generate' | 'repair'; error: Error };
  } = {},
) {
  const fixture = await prepareOperatorProposerFixture();
  const runtime = await createRuntime({ rootDirectory: fixture.root });
  if (!runtime.registry.catalog().plugins.includes('proposer.operator'))
    runtime.registry.registerOperation(operatorProposerDefinition);
  const requests: AgentInput[] = [];
  let generation = 0;
  const agent: OperationDefinition<AgentInput, AgentOutput, JsonObject> = {
    id: 'agent.operator-test',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(request, context): Promise<JsonObject> {
          requests.push(structuredClone(request));
          await context.charge('modelCalls', 1);
          const stage = object(request.input).stage;
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
              : [{ path: 'input.py', content: operatorFixtureSource(marker) }],
            reason: `Changed ${marker}`,
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
  bindings.proposer = {
    plugin: 'proposer.operator',
    config: {
      agentRef: 'agent',
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
  if (options.metrics) {
    const msprof = join(fixture.root, 'msprof.mjs');
    await copyFile(
      new URL('../fixtures/operator-sdk/msprof.mjs', import.meta.url),
      msprof,
    );
    await chmod(msprof, 0o755);
    object(object(bindings.evaluator).config).sdk = {
      ...object(object(object(bindings.evaluator).config).sdk),
      profiling: {
        enabled: false,
        cacheEnabled: false,
        warmup: 25,
        msprofBin: msprof,
        maxAttempts: 1,
        attemptTimeoutSeconds: 10,
      },
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

test('operator Proposer performs independent diagnosis/generation, repairs failed source and delivers the measured summary to a fresh entry proposal', async (t) => {
  const fixture = await setup(async (context, requests) => {
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
      await context.invoke('proposer', {
        action: 'summarize',
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
      requests[4]!.files?.['input.py'],
      operatorFixtureSource('fixture:latency=10'),
    );
    assert.equal(
      requests[2]!.files?.['input.py'],
      operatorFixtureSource('fixture:incorrect'),
    );
    assert.match(
      JSON.stringify(object(requests[2]!.input).evidence),
      /KERNEL_CONTRACT_FAILED/,
    );
    const child = await context.readCandidate(string(next.candidateRef));
    assert.equal(child.parentRef, entry);
    return { ...next, historyRef: summary.historyRef };
  });
  t.after(() => fixture.dispose());
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
        await context.invoke('proposer', {
          action: 'summarize',
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
          await context.invoke('proposer', {
            action: 'summarize',
            phase: 'metrics',
            parentCandidateRef: parent,
            incumbentMeasurementRef: incumbent,
            analysisRef: proposed.analysisRef,
            round,
            historyRef,
            staticHistoryRef: null,
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
        generates[1]!.files?.['input.py'],
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
        repairRequest.files?.['input.py'],
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
        await context.invoke('proposer', {
          action: 'summarize',
          phase: 'metrics',
          parentCandidateRef: entry,
          incumbentMeasurementRef: baselineRef,
          analysisRef: proposed.analysisRef,
          round: 1,
          historyRef: null,
          staticHistoryRef: null,
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

test('invalid metric analysis retains error evidence and fact history so later rounds can continue', async (t) => {
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
      for (let round = 1; round <= 2; round++) {
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
          await context.invoke('proposer', {
            action: 'summarize',
            phase: 'metrics',
            parentCandidateRef: entry,
            incumbentMeasurementRef: baselineRef,
            analysisRef: result.analysisRef,
            round,
            historyRef,
            staticHistoryRef: null,
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
        2,
      );
      return { historyRef };
    },
    false,
    { metrics: true, invalidMetrics: true },
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
        await context.invoke('proposer', {
          action: 'summarize',
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

const invalidEditResponse = () =>
  new Error(
    'Agent model-call limit reached; last output validation failed: agent output/edits must NOT have more than 1 items',
  );

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
      assert.match(string(error.message), /more than 1 items/);
      const summary = object(
        await context.invoke('proposer', {
          action: 'summarize',
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
    { editRejection: { stage: 'generate', error: invalidEditResponse() } },
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
        await context.invoke('proposer', {
          action: 'summarize',
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
    { editRejection: { stage: 'repair', error: invalidEditResponse() } },
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
