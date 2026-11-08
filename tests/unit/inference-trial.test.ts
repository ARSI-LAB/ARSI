import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationDefinition } from '../../src/contracts/index.js';
import { inferencebenchContract } from '../../src/contracts/plugin-types/inferencebench.js';
import { inferenceTrialDefinition } from '../../src/plugins/inference-trial/index.js';
import { InferenceStartupError } from '../../src/shared/errors.js';
import { object, string } from '../../src/shared/json.js';
import {
  managerFixture,
  measurementFixture,
} from '../helpers/manager-fixture.js';

test('inference trial classifies cleaned startup failures and incomplete measurements', async () => {
  let launches = 0;
  const evaluator: OperationDefinition = {
    id: 'test.inference-evaluator',
    contract: inferencebenchContract,
    configSchema: { type: 'object' },
    async create(config) {
      return {
        async execute(input, context) {
          launches++;
          const candidateRef = string(object(input).candidateRef);
          if (config.outcome === 'startup-failed')
            throw new InferenceStartupError('Invalid scheduler parameters');
          if (config.outcome === 'unexpected')
            throw new Error('Unknown remote transport outcome');
          const measurementRef = await context.recordMeasurement({
            ...(await measurementFixture(context)),
            candidateRef,
            coverage: config.outcome === 'partial' ? 'partial' : 'complete',
            status: config.outcome === 'unknown' ? 'unknown' : 'succeeded',
            comparisonKey: 'inference-comparison',
          });
          return { measurementRef };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const candidateRef = string(
        (await context.applicationMetadata()).initialCandidateRef,
      );
      const failed = await context.invoke('trial', {
        candidateRef,
        evaluatorRef: 'bad',
      });
      assert.deepEqual(failed, {
        status: 'startup-failed',
        measurementRef: null,
        reason: 'Invalid scheduler parameters',
      });
      const partial = object(
        await context.invoke('trial', {
          candidateRef,
          evaluatorRef: 'partial',
        }),
      );
      assert.equal(partial.status, 'invalid-measurement');
      assert.ok(typeof partial.measurementRef === 'string');
      const ready = object(
        await context.invoke('trial', { candidateRef, evaluatorRef: 'good' }),
      );
      assert.equal(ready.status, 'measured');
      assert.ok(typeof ready.measurementRef === 'string');

      const scoped = context.extend({
        scope: { id: 'replay', signal: context.signal, limits: {} },
      });
      for (let index = 0; index < 2; index++) {
        await assert.rejects(scoped.invoke('bad', { candidateRef }), {
          name: 'InferenceStartupError',
          message: 'Invalid scheduler parameters',
        });
      }
      assert.equal(
        launches,
        4,
        'replaying a failed receipt must not launch twice',
      );
      await assert.rejects(
        scoped.invoke('trial', { candidateRef, evaluatorRef: 'unknown' }),
        { status: 'unknown' },
      );
      await assert.rejects(
        scoped.invoke('trial', { candidateRef, evaluatorRef: 'unexpected' }),
        /Unknown remote transport outcome/,
      );
      return {};
    },
    {
      plugins: [evaluator, inferenceTrialDefinition],
      bindings: {
        trial: { plugin: inferenceTrialDefinition.id, config: {} },
        bad: { plugin: evaluator.id, config: { outcome: 'startup-failed' } },
        partial: { plugin: evaluator.id, config: { outcome: 'partial' } },
        good: { plugin: evaluator.id, config: {} },
        unknown: { plugin: evaluator.id, config: { outcome: 'unknown' } },
        unexpected: { plugin: evaluator.id, config: { outcome: 'unexpected' } },
      },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
  } finally {
    await fixture.dispose();
  }
});

test('inference trial skips an earlier equivalent parameter file regardless of candidate lineage', async () => {
  let evaluations = 0;
  const evaluator: OperationDefinition = {
    id: 'test.dedup-evaluator',
    contract: inferencebenchContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input, context) {
          evaluations++;
          assert.equal(object(input).reportFailedMeasurement, true);
          const measurementRef = await context.recordMeasurement({
            ...(await measurementFixture(context)),
            candidateRef: string(object(input).candidateRef),
            comparisonKey: 'inference-comparison',
          });
          return { measurementRef };
        },
        async dispose() {},
      };
    },
  };
  const fixture = await managerFixture(
    async (context) => {
      const parameterFile = 'config/tuning.json';
      const candidate = async (content: string, parentRef: string | null) =>
        context.recordCandidate(
          await context.artifacts.putJson({
            kind: 'file-tree',
            files: [
              {
                path: parameterFile,
                mode: 0o644,
                base64: Buffer.from(content).toString('base64'),
              },
            ],
          }),
          parentRef,
        );
      const baseline = await candidate(
        '{"max_num_seqs":8,"enforce_eager":true}',
        null,
      );
      const duplicate = await candidate(
        '{ "enforce_eager": true, "max_num_seqs": 8 }',
        baseline,
      );
      const novel = await candidate(
        '{"max_num_seqs":16,"enforce_eager":true}',
        duplicate,
      );
      assert.notEqual(baseline, duplicate);
      const deduplicate = { parameterFile, candidateRefs: [baseline] };
      assert.deepEqual(
        await context.invoke('trial', {
          candidateRef: duplicate,
          evaluatorRef: 'evaluator',
          deduplicate,
        }),
        {
          status: 'duplicate',
          measurementRef: null,
          reason: `Candidate parameters match ${baseline}`,
        },
      );
      assert.equal(evaluations, 0);
      const evaluated = object(
        await context.invoke('trial', {
          candidateRef: novel,
          evaluatorRef: 'evaluator',
          deduplicate,
        }),
      );
      assert.equal(evaluated.status, 'measured');
      assert.equal(evaluations, 1);
      return {};
    },
    {
      plugins: [evaluator, inferenceTrialDefinition],
      bindings: {
        trial: { plugin: inferenceTrialDefinition.id, config: {} },
        evaluator: { plugin: evaluator.id, config: {} },
      },
    },
  );
  try {
    assert.equal((await fixture.run()).status, 'succeeded');
  } finally {
    await fixture.dispose();
  }
});
