import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorProposerContract } from '../../src/contracts/plugin-types/proposer-operator.js';
import { validate } from '../../src/shared/schema.js';

test('metrics proposal contract supports a current parent and diagnostic through round ten', () => {
  const input = {
    action: 'propose',
    phase: 'metrics',
    parentCandidateRef: 'parent',
    incumbentMeasurementRef: 'assessment',
    diagnosticMeasurementRef: 'profile',
    round: 10,
    historyRef: 'history',
    staticHistoryRef: null,
    goal: 'Optimize the measured bottleneck',
  };
  assert.doesNotThrow(() =>
    validate(operatorProposerContract.input_schema, input),
  );
  assert.throws(() =>
    validate(operatorProposerContract.input_schema, { ...input, round: 11 }),
  );
  assert.throws(() =>
    validate(operatorProposerContract.input_schema, {
      ...input,
      diagnosticMeasurementRef: null,
    }),
  );
});

test('invalid model output is an explicit business failure with retained analysis and error evidence', () => {
  assert.doesNotThrow(() =>
    validate(operatorProposerContract.output_schema, {
      action: 'propose',
      status: 'failed',
      candidateRef: 'parent',
      diffRef: null,
      analysisRef: 'draft',
      errorRef: 'error',
      rationale: 'Invalid JSON',
      reasonCode: 'invalid-model-output',
    }),
  );
});

async function metricAnalysisModule(): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(
    new URL(
      '../../src/plugins/proposer-operator/metrics-analysis.ts',
      import.meta.url,
    ).href
  );
  assert.ok(loaded && typeof loaded === 'object');
  return loaded as Record<string, unknown>;
}
test('metric analysis requires measured numeric evidence and keeps model inference distinct', async () => {
  const loaded = await metricAnalysisModule();
  const parse = loaded.parseMetricsBottleneck;
  assert.equal(typeof parse, 'function');
  if (typeof parse !== 'function') throw new Error('Missing metrics parser');
  const profile = { kernels: [{ metrics: { '0': { aiv_vec_ratio: 0.8 } } }] };
  const reply = {
    category: 'vector',
    summary: 'Vector pipe is busy',
    reasoning: 'Optimize the vector work',
    rootCause: 'A hypothesis about the reduction',
    recommendedFix: 'Reduce scalar overhead',
    evidence: [{ path: '/kernels/0/metrics/0/aiv_vec_ratio', value: 0.8 }],
  };
  assert.deepEqual(parse(reply, profile), reply);
  assert.throws(
    () =>
      parse(
        {
          ...reply,
          evidence: [
            { path: '/kernels/0/metrics/0/aiv_vec_ratio', value: 0.9 },
          ],
        },
        profile,
      ),
    /evidence/i,
  );
  assert.throws(
    () =>
      parse(
        { ...reply, evidence: [{ path: '/metadata/ub_ratio', value: 0.5 }] },
        profile,
      ),
    /evidence/i,
  );
});

test('operator edits reject unauthorized paths and oversized UTF-8 output as model data', async () => {
  const loaded: unknown = await import(
    new URL('../../src/plugins/proposer-operator/editing.ts', import.meta.url)
      .href
  );
  assert.ok(loaded && typeof loaded === 'object');
  const parse: unknown = Reflect.get(loaded, 'validateOperatorEdits');
  if (typeof parse !== 'function')
    throw new Error('Missing operator edit validation');
  assert.doesNotThrow(() =>
    parse({
      edits: [{ path: 'input.py', content: 'valid code' }],
      reason: 'One measured hypothesis',
    }),
  );
  assert.throws(
    () =>
      parse({
        edits: [{ path: 'context/task/test.py', content: 'weaken' }],
        reason: 'Invalid change',
      }),
    /operator.*edit|path/i,
  );
  assert.throws(
    () =>
      parse({
        edits: [{ path: 'input.py', content: '算'.repeat(12000) }],
        reason: 'Too many bytes',
      }),
    /byte/i,
  );
});
