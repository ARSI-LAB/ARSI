import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  buildTrainingFeedback,
  aggregateTrainingMetrics,
} from '../../src/plugins/evaluator-agentbench/training-feedback.js';
import { projectEvidence } from '../../src/runtime/services/facts/evidence.js';

test('native quality feedback maps WorkBuddy checks and Harbor rewards without inventing missing tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-training-'));
  const artifacts = new FileArtifacts(root);
  try {
    const workbuddy = await buildTrainingFeedback(artifacts, 'workbuddy/task', {
      key: { attemptId: 'attempt' },
      status: 'completed',
      scoreStatus: 'valid',
      verdict: {
        score: 0.8707,
        passed: false,
        details: {
          primary: 'reward',
          passThreshold: 1,
          rewards: { reward: 0.8707, tests_passed: 330, tests_total: 379 },
          evidence: {
            judges: [
              {
                metadata: {
                  stdout:
                    'test_verify.py::test_atomic_check[table_structure] FAILED [ 6%]\n',
                  private: 'HIDDEN_PLAN',
                },
                verdicts: [
                  {
                    item_id: 'rule',
                    status: 'fail',
                    score: 0.8707,
                    reason: 'Partial pass',
                  },
                ],
              },
            ],
            diagnostics: { plan: 'HIDDEN_PLAN' },
          },
        },
      },
      errors: [],
    });
    const feedback = (await artifacts.readJson(
      workbuddy.evaluation.artifactRef as string,
    )) as JsonObject;
    assert.equal(feedback.passed, false);
    assert.equal(feedback.primaryReward, 'reward');
    assert.match(JSON.stringify(feedback.checks), /table_structure/);
    assert.equal(feedback.checksComplete, null);
    assert.doesNotMatch(JSON.stringify(feedback), /HIDDEN_PLAN/);
    assert.deepEqual((workbuddy.metrics.score as JsonObject).value, {
      kind: 'scalar',
      value: 0.8707,
    });
    assert.deepEqual(
      (workbuddy.metrics['reward.tests_passed'] as JsonObject).value,
      { kind: 'scalar', value: 330 },
    );
    for (const id of ['swebench/task', 'terminal-bench/task']) {
      const item = await buildTrainingFeedback(artifacts, id, {
        key: { attemptId: id },
        status: 'completed',
        scoreStatus: 'valid',
        verdict: {
          score: 0,
          passed: false,
          details: {
            rewards: { reward: 0, custom: 2 },
            primary: 'reward',
            passThreshold: 1,
            evidence: { format: 'txt', exitCode: 1 },
          },
        },
      });
      const f = (await artifacts.readJson(
        item.evaluation.artifactRef as string,
      )) as JsonObject;
      assert.deepEqual(f.checks, []);
      assert.equal(f.checksComplete, null);
      assert.equal(f.passed, false);
      assert.deepEqual((item.metrics.score as JsonObject).value, {
        kind: 'scalar',
        value: 0,
      });
      assert.deepEqual((item.metrics['reward.custom'] as JsonObject).value, {
        kind: 'scalar',
        value: 2,
      });
    }
    const invalid = await buildTrainingFeedback(artifacts, 'task', {
      status: 'error',
      scoreStatus: 'invalid',
      verdict: { score: 1, passed: true, details: {} },
      errors: [{ phase: 'verify', code: 'BROKEN', message: 'Verifier failed' }],
    });
    assert.equal((invalid.metrics.score as JsonObject).status, 'unavailable');
    const missing = await buildTrainingFeedback(artifacts, 'missing', null);
    assert.equal((missing.metrics.score as JsonObject).status, 'unavailable');
    const aggregate = await aggregateTrainingMetrics(
      artifacts,
      [{ metrics: workbuddy.metrics }, { metrics: missing.metrics }],
      'artifact:items',
    );
    assert.equal((aggregate.score as JsonObject).status, 'unavailable');
    const complete = await aggregateTrainingMetrics(
      artifacts,
      [{ metrics: workbuddy.metrics }, { metrics: workbuddy.metrics }],
      'artifact:items',
    );
    assert.deepEqual((complete.score as JsonObject).value, {
      kind: 'scalar',
      value: 0.8707,
    });
    const verifierLogs = await artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'test-stdout.txt',
          mode: 0o644,
          base64: Buffer.from(
            'FAILED tests/test_task.py::test_result - AssertionError\n',
          ).toString('base64'),
        },
        {
          path: 'reference_answer.json',
          mode: 0o644,
          base64: Buffer.from('HIDDEN_REFERENCE').toString('base64'),
        },
      ],
    });
    const shell = await buildTrainingFeedback(
      artifacts,
      'terminal-bench/task',
      {
        status: 'completed',
        scoreStatus: 'valid',
        verdict: {
          passed: false,
          score: 0,
          details: { rewards: { 'custom/key': 0 } },
        },
      },
      verifierLogs,
    );
    const shellFeedback = await artifacts.readJson(
      shell.evaluation.artifactRef as string,
    );
    assert.match(JSON.stringify(shellFeedback), /test_result/);
    assert.doesNotMatch(JSON.stringify(shellFeedback), /HIDDEN_REFERENCE/);
    assert.equal(
      ((shell.metrics['reward.custom/key'] as JsonObject).source as JsonObject)
        .pointer,
      '/verdict/details/rewards/custom~1key',
    );

    const itemsRef = await artifacts.putJson({
      schemaVersion: 'rsi.measurement-items/v1',
      items: [
        {
          id: 'workbuddy/task',
          subject: { kind: 'task' },
          metrics: workbuddy.metrics,
          evaluation: workbuddy.evaluation,
        },
      ],
    });
    const index = await artifacts.putJson({ entries: [] });
    const measurement = {
      schemaVersion: 'rsi.measurement/v1',
      ref: 'measurement-test',
      status: 'succeeded',
      coverage: 'complete',
      metrics: {},
      evidenceIndexRef: index,
      itemsRef,
    };
    const training = await projectEvidence({
      measurements: [measurement],
      artifacts,
      view: 'training-summary',
      maxBytes: 24000,
    });
    const text = JSON.stringify(training);
    assert.match(text, /0\.8707/);
    assert.match(text, /table_structure/);
    assert.match(text, /passThreshold/);
    assert.match(text, /metricDefinitions/);
    for (const view of ['execution', 'delivery'] as const) {
      const projected = await projectEvidence({
        measurements: [measurement],
        artifacts,
        view,
        maxBytes: 24000,
      });
      assert.doesNotMatch(
        JSON.stringify(projected),
        /table_structure|passThreshold|0\.8707/,
      );
    }
    const bounded = await projectEvidence({
      measurements: [measurement],
      artifacts,
      view: 'training-summary',
      maxBytes: 700,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 700);
    assert.match(JSON.stringify(bounded), /truncated.*true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
