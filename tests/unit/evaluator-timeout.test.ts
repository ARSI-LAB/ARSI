import test from 'node:test';
import assert from 'node:assert/strict';
import { isFinalizedVerifierTimeout } from '../../src/plugins/evaluator-agentbench/finalized-timeout.js';

function fixture() {
  return {
    kind: 'local',
    exitCode: 1,
    snapshot: {
      run: {
        runId: 'run',
        status: 'error',
        taskIds: ['task'],
        finishedAt: '2026-11-05T00:00:00Z',
      },
      pendingTaskIds: [] as string[],
      records: [
        {
          key: { runId: 'run', taskId: 'task', attemptId: 'attempt' },
          executionStatus: 'failed',
          scoreStatus: 'invalid',
          cleanupStatus: 'cleaned',
          errors: [
            {
              code: 'VERIFY_TIMEOUT',
              phase: 'verify',
              category: 'verifier',
              scope: 'attempt',
              retryable: false,
              action: 'finalize',
            },
          ],
        },
      ],
    },
  };
}

test('only collected, finalized verifier timeouts with confirmed cleanup are evaluation outcomes', () => {
  assert.equal(isFinalizedVerifierTimeout(fixture(), ['task']), true);
  const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
    (v) => {
      v.exitCode = 0;
    },
    (v) => {
      v.snapshot.run.status = 'running';
    },
    (v) => {
      v.snapshot.run.status = 'cancelled';
    },
    (v) => {
      v.snapshot.run.finishedAt = '';
    },
    (v) => {
      v.snapshot.pendingTaskIds.push('task');
    },
    (v) => {
      v.snapshot.records = [];
    },
    (v) => {
      v.snapshot.records[0]!.cleanupStatus = 'unconfirmed';
    },
    (v) => {
      v.snapshot.records[0]!.key.taskId = 'other';
    },
    (v) => {
      v.snapshot.records[0]!.errors[0]!.code = 'DOCKER_UNAVAILABLE';
    },
    (v) => {
      v.snapshot.records[0]!.errors[0]!.retryable = true;
    },
    (v) => {
      v.snapshot.records[0]!.errors[0]!.scope = 'run';
    },
    (v) => {
      v.snapshot.records[0]!.errors.push({
        ...v.snapshot.records[0]!.errors[0]!,
        code: 'COLLECT_FAILED',
      });
    },
  ];
  for (const change of mutations) {
    const value = fixture();
    change(value);
    assert.equal(isFinalizedVerifierTimeout(value, ['task']), false);
  }
  assert.equal(isFinalizedVerifierTimeout(fixture(), ['other']), false);
  assert.equal(isFinalizedVerifierTimeout({ exitCode: 1 }, ['task']), false);
});
