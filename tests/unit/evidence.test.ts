import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { projectEvidence } from '../../src/runtime/services/facts/evidence.js';

test('evidence projection is bounded, anonymous for delivery, and never leaks private scoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-evidence-'));
  const artifacts = new FileArtifacts(root);
  try {
    const trajectoryLines = Array.from({ length: 2000 }, (_, index) =>
      JSON.stringify({
        event: 'tool-result',
        content: `line ${index} ` + 'x'.repeat(300),
        score: 0.123,
        verdict: { passed: true },
        private: { answer: 'PRIVATE_ANSWER' },
      }),
    ).join('\n');
    const trajectory = await artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'trajectory.jsonl',
          mode: 420,
          base64: Buffer.from(trajectoryLines).toString('base64'),
        },
      ],
    });
    const delivery = await artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'result.txt',
          mode: 420,
          base64: Buffer.from('Completed deliverable').toString('base64'),
        },
        {
          path: 'result.xlsx',
          mode: 420,
          base64: Buffer.from([0, 1, 2, 3]).toString('base64'),
        },
      ],
    });
    const privateResult = await artifacts.putJson({
      verdict: { score: 1 },
      secret: 'PRIVATE_RESULT',
    });
    const index = await artifacts.putJson({
      entries: [
        {
          kind: 'trajectory',
          artifactRef: trajectory,
          access: 'execution',
          itemId: 'task',
          attemptId: 'candidate-identifying-attempt',
          integrity: 'complete',
        },
        {
          kind: 'delivery',
          artifactRef: delivery,
          access: 'delivery',
          itemId: 'task',
          attemptId: 'candidate-identifying-attempt',
          integrity: 'complete',
        },
        {
          kind: 'native-result',
          artifactRef: privateResult,
          access: 'private',
          integrity: 'complete',
        },
      ],
    });
    const measurement = {
      schemaVersion: 'rsi.measurement/v1',
      ref: 'measurement-secret-label',
      candidateRef: 'candidate-secret-label',
      status: 'succeeded',
      coverage: 'complete',
      metrics: { successRate: 0.123 },
      evidenceIndexRef: index,
    };
    const execution = await projectEvidence({
      measurements: [measurement],
      artifacts,
      view: 'execution',
      maxBytes: 4096,
    });
    const raw = JSON.stringify(execution);
    assert.ok(Buffer.byteLength(raw) <= 4096);
    assert.match(raw, /truncated/);
    assert.match(raw, /artifact:/);
    assert.doesNotMatch(
      raw,
      /PRIVATE_ANSWER|PRIVATE_RESULT|0\.123|"score"|"verdict"|"metrics"/,
    );
    const anonymous = JSON.stringify(
      await projectEvidence({
        measurements: [measurement],
        artifacts,
        view: 'delivery',
        maxBytes: 4096,
      }),
    );
    assert.match(anonymous, /Completed deliverable/);
    assert.match(anonymous, /uninspected/);
    assert.doesNotMatch(
      anonymous,
      /candidate-secret-label|measurement-secret-label|candidate-identifying-attempt|trajectory|successRate/,
    );
    const training = JSON.stringify(
      await projectEvidence({
        measurements: [measurement],
        artifacts,
        view: 'training-summary',
        maxBytes: 4096,
      }),
    );
    assert.match(training, /successRate/);
    await assert.rejects(
      projectEvidence({
        measurements: [{ ref: delivery }],
        artifacts,
        view: 'execution',
        maxBytes: 4096,
      }),
      /Measurement/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
