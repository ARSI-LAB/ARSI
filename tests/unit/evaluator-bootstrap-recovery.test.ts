import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { canRestartBootstrap } from '../../src/plugins/evaluator-agentbench/bootstrap-recovery.js';

test('bootstrap recovery requires no native execution and confirmed Application release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-bootstrap-recovery-'));
  const input = { candidateRef: 'candidate', taskIds: ['task'] };
  const receipt = {
    callId: 'call',
    experimentId: 'experiment',
    status: 'cancelled',
    measurementRef: 'measurement',
  };
  const measurement = {
    ref: 'measurement',
    callId: 'call',
    experimentId: 'experiment',
    candidateRef: 'candidate',
    evaluator: { pluginId: 'evaluator.agentbench' },
    status: 'cancelled',
    coverage: 'unknown',
    diagnosticsRef: 'diagnostic',
    provenance: { artifactRef: 'provenance' },
  };
  const diagnostic = {
    name: 'EvaluatorRunError',
    phase: 'bootstrap',
    message:
      'Skill frontmatter is missing: plugins/base/skills/example/SKILL.md',
  };
  const provenance = {
    runIdentity: null,
    usageKnown: false,
    nativeResult: {
      kind: null,
      runId: null,
      jobId: null,
      exitCode: null,
      resultRef: 'result',
    },
    configuration: {
      scheduler: { name: 'local' },
      run: { taskIds: ['task'] },
      output: { directory: join(directory, 'sdk') },
    },
  };
  const saved: JsonObject = { result: {}, snapshot: null, metrics: null };
  const records: Record<string, JsonObject> = {
    diagnostic,
    provenance,
    result: saved,
  };
  let released = false;
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'call',
    directory,
    signal: new AbortController().signal,
    readMeasurement: async () => measurement as never,
    artifacts: { readJson: async (ref: string) => records[ref]! } as never,
    facts: {
      list: async (): Promise<JsonObject[]> => [
        {
          parentCallId: 'call',
          experimentId: 'experiment',
          status: 'succeeded',
          bindingId: '_application',
          input: { action: 'acquire' },
          output: { instanceId: 'owned' },
        },
        {
          parentCallId: 'call',
          experimentId: 'experiment',
          status: 'succeeded',
          bindingId: '_application',
          input: { action: 'release', instanceId: 'owned' },
          output: { status: 'released' },
        },
      ],
      read: async () => ({
        status: released ? 'released' : 'ready',
        experimentId: 'experiment',
        candidateRef: 'candidate',
      }),
      write: async () => {
        throw new Error('Recovery must be read-only');
      },
    },
  });
  try {
    assert.equal(await canRestartBootstrap(input, receipt, context), false);
    released = true;
    assert.equal(await canRestartBootstrap(input, receipt, context), true);
    assert.equal(
      await canRestartBootstrap(
        { ...input, taskIds: ['other'] },
        receipt,
        context,
      ),
      false,
    );
    assert.equal(
      await canRestartBootstrap(
        input,
        { ...receipt, status: 'unknown' },
        context,
      ),
      false,
    );
    for (const patch of [
      { phase: 'solve' },
      { name: 'UnknownError' },
      { message: 'Unknown infrastructure failure' },
      {
        message:
          'Skill frontmatter is missing: plugins/base/skills/example/SKILL.md; cause: disposal failed',
      },
    ]) {
      Object.assign(diagnostic, patch);
      assert.equal(await canRestartBootstrap(input, receipt, context), false);
      Object.assign(diagnostic, {
        name: 'EvaluatorRunError',
        phase: 'bootstrap',
        message:
          'Skill frontmatter is missing: plugins/base/skills/example/SKILL.md',
      });
    }
    saved.snapshot = { run: { status: 'running' } };
    assert.equal(await canRestartBootstrap(input, receipt, context), false);
    saved.snapshot = null;
    saved.result = { runId: 'started' };
    assert.equal(await canRestartBootstrap(input, receipt, context), false);
    saved.result = {};
    await mkdir(join(directory, 'sdk'));
    assert.equal(await canRestartBootstrap(input, receipt, context), false);
    assert.equal(
      await canRestartBootstrap(
        input,
        receipt,
        context.extend({ signal: AbortSignal.abort() }),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
