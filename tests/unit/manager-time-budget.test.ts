import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { RuntimeContext } from '../../src/contracts/index.js';
import type { FactStore, JsonObject } from '../../src/contracts/index.js';
import { BudgetLedger } from '../../src/runtime/manager/budget.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

test('Policy time admission uses measured baseline duration and preserves the result on resume', async () => {
  let calls = 0;
  const fixture = await managerFixture(
    async () => {
      calls++;
      if (calls === 1) {
        await setTimeout(30);
        return { status: 'startup-failed' };
      }
      await setTimeout(20);
      return { status: 'measured' };
    },
    {
      policy: {
        steps: [
          { id: 'failed_start', type: 'invoke', use: 'driver' },
          {
            id: 'baseline_budget',
            type: 'time-budget',
            stage: 'enablement',
            limitMs: 3000,
            actions: [{ use: 'driver', initialMs: 200, status: 'measured' }],
          },
          { id: 'baseline', type: 'invoke', use: 'driver' },
          {
            id: 'candidate_budget',
            type: 'time-budget',
            stage: 'framework',
            limitMs: 5,
            actions: [{ use: 'driver', initialMs: 1, status: 'measured' }],
          },
          {
            id: 'evaluate',
            type: 'if',
            if: '${{ steps.candidate_budget.output.fits }}',
            then: {
              steps: [{ id: 'candidate', type: 'invoke', use: 'driver' }],
            },
          },
        ],
        output: {
          baseline: '${{ steps.baseline_budget.output }}',
          candidate: '${{ steps.candidate_budget.output }}',
        },
      },
    },
  );
  try {
    const result = await fixture.run();
    const output = object(result.output);
    const baseline = object(output.baseline);
    const candidate = object(output.candidate);
    assert.equal(baseline.fits, true);
    assert.equal(baseline.estimatedMs, 200);
    const receipt = (await fixture.manager.facts.list('calls')).find(
      (call) =>
        call.bindingId === 'driver' &&
        object(call.output).status === 'measured',
    );
    assert.ok(receipt);
    const duration =
      Date.parse(string(receipt.finishedAt)) -
      Date.parse(string(receipt.startedAt));
    assert.ok(duration > 5);
    assert.equal(candidate.estimatedMs, duration);
    assert.equal(candidate.fits, false);
    assert.equal(candidate.reason, 'stage-time');
    assert.equal(calls, 2);
    const resumed = await fixture.manager.run(string(result.recipePath), {
      id: 'test',
      resume: true,
    });
    assert.deepEqual(resumed.output, output);
    assert.equal(calls, 2);
  } finally {
    await fixture.dispose();
  }
});

test('Elapsed time stays charged to the same stage after the Manager is recreated', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const records = new Map<string, JsonObject>();
  const facts: FactStore = {
    async read(kind, ref) {
      const record = records.get(`${kind}/${ref}`);
      if (!record)
        throw Object.assign(new Error('Missing record'), { code: 'ENOENT' });
      return record;
    },
    async write(kind, ref, record) {
      records.set(`${kind}/${ref}`, record);
    },
    async list() {
      return [];
    },
  };
  const ledger = () =>
    new BudgetLedger('time', facts, { elapsedWallMs: 1000 }, (error) => {
      throw error;
    });
  const request = {
    stage: 'framework',
    limitMs: 500,
    actions: [{ use: 'evaluator', initialMs: 100 }],
  };
  const context = new RuntimeContext().extend({
    callId: 'root',
    signal: new AbortController().signal,
  });
  const startedAt = 1000;
  assert.deepEqual(await ledger().timeBudget(request, startedAt, context), {
    fits: true,
    remainingMs: 500,
    estimatedMs: 100,
    reason: 'fits',
  });
  t.mock.timers.tick(410);
  assert.deepEqual(await ledger().timeBudget(request, startedAt, context), {
    fits: false,
    remainingMs: 90,
    estimatedMs: 100,
    reason: 'stage-time',
  });
  t.mock.timers.tick(500);
  assert.deepEqual(
    await ledger().timeBudget(
      { ...request, stage: 'other', limitMs: null },
      startedAt,
      context,
    ),
    {
      fits: false,
      remainingMs: 90,
      estimatedMs: 100,
      reason: 'experiment-time',
    },
  );
});

for (const interrupted of ['before-receipt', 'after-receipt'] as const) {
  test(`Time admission reconciles a resumed branch interrupted ${interrupted}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    let executions = 0;
    const fixture = await managerFixture(
      async () => {
        executions++;
        return { status: 'measured' };
      },
      {
        policy: {
          steps: [
            {
              id: 'admit',
              type: 'time-budget',
              stage: 'framework',
              limitMs: 1000,
              actions: [{ use: 'driver', initialMs: 100 }],
              then: {
                steps: [{ id: 'drive', type: 'invoke', use: 'driver' }],
                output: '${{ budget.reason }}',
              },
              else: { steps: [], output: '${{ budget.reason }}' },
            },
          ],
          output: { reason: '${{ steps.admit.output }}' },
        },
      },
    );
    t.after(() => fixture.dispose());
    const facts = fixture.manager.facts;
    const write = facts.write.bind(facts);
    const path = 'steps/admit/then/drive';
    facts.write = async (kind, ref, value) => {
      if (
        value.path === path &&
        (interrupted === 'before-receipt'
          ? kind === 'calls' && value.status === 'running'
          : kind === 'checkpoint-entries')
      )
        throw new Error('Interrupted before guarded checkpoint');
      await write(kind, ref, value);
    };
    try {
      await assert.rejects(
        fixture.run(),
        /Interrupted before guarded checkpoint/,
      );
    } finally {
      facts.write = write;
    }
    const result = await fixture.manager.get('test');
    t.mock.timers.tick(1100);
    const resumed = await fixture.manager.run(string(result.recipePath), {
      id: 'test',
      resume: true,
    });
    assert.deepEqual(resumed.output, {
      reason: interrupted === 'before-receipt' ? 'stage-time' : 'fits',
    });
    assert.equal(executions, interrupted === 'before-receipt' ? 0 : 1);
  });
}
