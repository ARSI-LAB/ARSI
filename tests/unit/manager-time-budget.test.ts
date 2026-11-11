import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';

for (const metric of ['operations', 'elapsedWallMs'] as const) {
  test(`Manager records partial Policy output when ${metric} is exhausted`, async () => {
    let calls = 0;
    const fixture = await managerFixture(
      async (context) => {
        if (++calls === 1) return { measurementRef: 'confirmed' };
        await setTimeout(30_000, undefined, { signal: context.signal });
        return { measurementRef: 'unfinished' };
      },
      {
        budget:
          metric === 'operations' ? { operations: 2 } : { elapsedWallMs: 3000 },
        policy: {
          state_schema: { type: 'object' },
          state: { best: null },
          steps: [
            { id: 'measure', type: 'invoke', use: 'driver' },
            {
              id: 'search',
              type: 'if',
              if: true,
              then: {
                steps: [
                  {
                    id: 'adopt',
                    type: 'state',
                    state: {
                      best: '${{ steps.measure.output.measurementRef }}',
                    },
                  },
                  { id: 'next', type: 'invoke', use: 'driver' },
                ],
              },
            },
          ],
          output: {
            best: '${{ state.best }}',
            first: '${{ steps.measure.output.measurementRef }}',
          },
        },
      },
    );
    try {
      await assert.rejects(
        fixture.run(),
        /Budget exceeded: operations|timeout/i,
      );
      const result = await fixture.manager.get('test');
      assert.equal(result.stopReason, 'budget-exhausted');
      assert.equal(result.budgetMetric, metric);
      assert.deepEqual(result.partialOutput, {
        best: 'confirmed',
        first: 'confirmed',
      });
      assert.equal(result.output, undefined);
      assert.equal(calls, metric === 'operations' ? 1 : 2);
      if (metric === 'elapsedWallMs') {
        await assert.rejects(
          fixture.manager.run(string(result.recipePath), {
            id: 'test',
            resume: true,
          }),
          /Experiment wall-time budget exceeded/,
        );
        const expired = await fixture.manager.get('test');
        assert.equal(expired.budgetMetric, 'elapsedWallMs');
        assert.deepEqual(expired.partialOutput, result.partialOutput);
        assert.deepEqual(expired.usage, result.usage);
        assert.equal(calls, 2);
      }
    } finally {
      await fixture.dispose();
    }
  });
}
