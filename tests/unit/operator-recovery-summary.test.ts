import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../src/contracts/index.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'operator-recovery-summary-'));
  const registry = new Registry();
  const manager = new Manager({ rootDirectory: directory, registry });
  const id = 'interrupted-search';
  await manager.facts.write('experiments', id, {
    id,
    status: 'failed',
    error: 'Winner profile cleanup unknown',
    application: { initialCandidateRef: 'baseline' },
    usage: { evaluationRuns: 5, modelCalls: 6 },
  });
  const itemsRef = await manager.artifacts.putJson({ items: [] });
  const conditionsRef = await manager.artifacts.putJson({ mode: 'sdk' });
  for (const [ref, parentRef, code, latency] of [
    ['baseline', null, 'baseline source\n', 10],
    ['slow', 'baseline', 'slow source\n', 11],
    ['winner', 'baseline', 'winner source\n', 8],
  ] as const) {
    const artifactRef = await manager.artifacts.putJson({
      files: [
        { path: 'input.py', base64: Buffer.from(code).toString('base64') },
      ],
    });
    const provenanceRef = await manager.artifacts.putJson({
      mode: 'sdk',
      cleanup: 'confirmed',
      artifactRef,
      sourceDigest: ref,
    });
    await manager.facts.write('candidates', ref, {
      ref,
      experimentId: id,
      artifactRef,
      parentRef,
    });
    await manager.facts.write('measurements', `m-${ref}`, {
      ref: `m-${ref}`,
      experimentId: id,
      candidateRef: ref,
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'comparison',
      itemsRef,
      diagnosticsRef: null,
      evidenceIndexRef: null,
      conditions: { artifactRef: conditionsRef },
      provenance: { artifactRef: provenanceRef },
      metrics: {
        candidateValid: {
          status: 'available',
          value: { kind: 'scalar', value: 1 },
        },
        latencyMeanMs: {
          status: 'available',
          value: { kind: 'scalar', value: latency },
        },
      },
    });
  }
  async function call(name: string, value: JsonObject): Promise<void> {
    await manager.facts.write('calls', name, {
      experimentId: id,
      status: 'succeeded',
      ...value,
    });
  }
  await call('z-baseline-evaluation', {
    path: 'steps/evaluate_baseline',
    bindingId: 'evaluator',
    pluginId: 'evaluator.operatorbench',
    input: { action: 'evaluate', candidateRef: 'baseline' },
    output: { measurementRef: 'm-baseline' },
  });
  await call('z-baseline-selection', {
    path: 'steps/check_baseline',
    bindingId: 'selector',
    pluginId: 'selector.metric',
    input: {
      incumbentMeasurementRef: 'm-baseline',
      candidateMeasurementRef: 'm-baseline',
    },
    output: {
      accepted: false,
      selectedCandidateRef: 'baseline',
      measurementRef: 'm-baseline',
    },
  });
  async function propose(round: number, candidate: string): Promise<void> {
    await call(`proposal-${round}`, {
      path: `steps/run_metrics/then/metrics_loop/iteration-${round - 1}/admit_round/then/metrics_propose`,
      bindingId: 'proposer',
      pluginId: 'proposer.operator',
      input: {
        action: 'propose',
        phase: 'metrics',
        round,
        parentCandidateRef: 'baseline',
        incumbentMeasurementRef: 'm-baseline',
        diagnosticMeasurementRef: 'p-baseline',
      },
      output: {
        status: 'created',
        candidateRef: candidate,
        diffRef: `diff-${candidate}`,
        analysisRef: `analysis-${round}`,
      },
    });
    await call(`evaluation-${round}`, {
      path: `steps/run_metrics/then/metrics_loop/iteration-${round - 1}/admit_round/then/assess_metrics_proposal/then/metrics_evaluate`,
      bindingId: 'evaluator',
      pluginId: 'evaluator.operatorbench',
      input: { action: 'evaluate', candidateRef: candidate },
      output: { measurementRef: `m-${candidate}` },
    });
  }
  async function report(): Promise<JsonObject> {
    const module: unknown = await import(
      new URL('../../scripts/operator-inputs.mjs', import.meta.url).href
    );
    assert.ok(module && typeof module === 'object');
    const summarize: unknown = Reflect.get(
      module,
      'summarizeOperatorExperiment',
    );
    assert.equal(typeof summarize, 'function');
    if (typeof summarize !== 'function')
      throw new Error('Missing summary helper');
    return object(
      await summarize(manager, id, join(directory, 'manifest.json')),
    );
  }
  return {
    manager,
    call,
    propose,
    report,
    async dispose() {
      await manager.dispose();
      await registry.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('interrupted search reports the last confirmed promotion and completed metric history', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await f.propose(1, 'slow');
  await f.call('summary-1', {
    path: 'steps/run_metrics/then/metrics_loop/iteration-0/admit_round/then/metrics_summarize',
    bindingId: 'proposer',
    pluginId: 'proposer.operator',
    input: {
      action: 'summarize',
      phase: 'metrics',
      round: 1,
      parentCandidateRef: 'baseline',
      incumbentMeasurementRef: 'm-baseline',
      analysisRef: 'analysis-1',
      candidateRefs: ['slow'],
      measurementRefs: ['m-slow'],
      decisionRef: 'decision-slow',
      candidateDiagnosticMeasurementRef: null,
      outcome: 'verified-no-gain',
    },
    output: { summaryRef: 'summary-ref-1', historyRef: 'history-ref-1' },
  });
  await f.propose(2, 'winner');
  await f.call('a-promotion', {
    path: 'steps/run_metrics/then/metrics_loop/iteration-1/admit_round/then/assess_metrics_proposal/then/metrics_select',
    bindingId: 'selector',
    pluginId: 'selector.metric',
    input: {
      incumbentMeasurementRef: 'm-baseline',
      candidateMeasurementRef: 'm-winner',
    },
    output: {
      accepted: true,
      selectedCandidateRef: 'winner',
      measurementRef: 'm-winner',
      decisionRef: 'decision-winner',
    },
  });
  await f.call('unconfirmed-profile', {
    path: 'steps/run_metrics/then/metrics_loop/iteration-1/admit_round/then/promote_metrics/then/profile_winner',
    bindingId: 'evaluator',
    pluginId: 'evaluator.operatorbench',
    status: 'unknown',
    input: {
      action: 'profile',
      candidateRef: 'winner',
      assessmentMeasurementRef: 'm-winner',
    },
  });
  const before = await f.manager.facts.list('calls');
  const result = await f.report();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Winner profile cleanup unknown');
  assert.equal(object(result.bestSource).candidateRef, 'winner');
  assert.equal(
    await readFile(string(object(result.bestSource).path), 'utf8'),
    'winner source\n',
  );
  assert.equal(object(result.bestMeasurement).measurementRef, 'm-winner');
  assert.equal(result.phase, 'metrics');
  assert.equal(result.historyRef, 'history-ref-1');
  assert.equal(object((result.metricsRounds as JsonObject[])[0]).round, 1);
  assert.equal(object((result.incompleteAttempts as JsonObject[])[0]).round, 2);
  assert.equal(result.finalMeasurement, null);
  assert.equal(result.finalValidity, null);
  assert.deepEqual(await f.manager.facts.list('calls'), before);
});

test('unknown selection and final retest selection cannot replace the confirmed search incumbent', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await f.propose(1, 'winner');
  await f.call('unknown-promotion', {
    path: 'steps/run_metrics/then/metrics_loop/iteration-0/admit_round/then/assess_metrics_proposal/then/metrics_select',
    bindingId: 'selector',
    pluginId: 'selector.metric',
    status: 'unknown',
    input: {
      incumbentMeasurementRef: 'm-baseline',
      candidateMeasurementRef: 'm-winner',
    },
    output: {
      accepted: true,
      selectedCandidateRef: 'winner',
      measurementRef: 'm-winner',
    },
  });
  await f.call('final-selection', {
    path: 'steps/check_final',
    bindingId: 'selector',
    pluginId: 'selector.metric',
    input: {
      incumbentMeasurementRef: 'm-baseline',
      candidateMeasurementRef: 'm-winner',
    },
    output: {
      accepted: true,
      selectedCandidateRef: 'winner',
      measurementRef: 'm-winner',
      candidateFeasible: true,
      decisionRef: 'final-decision',
    },
  });
  const result = await f.report();
  assert.equal(result.status, 'failed');
  assert.equal(object(result.bestSource).candidateRef, 'baseline');
  assert.equal(object(result.bestMeasurement).measurementRef, 'm-baseline');
});
