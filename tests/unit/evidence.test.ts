import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  fullEvidenceText,
  projectEvidence,
} from '../../src/runtime/services/facts/evidence.js';
import type { JsonValue } from '../../src/contracts/index.js';
import { projectEvidenceFiles } from '../../src/runtime/services/facts/evidence-files.js';
import { object } from '../../src/shared/json.js';

test('Full evidence retains deeply nested and large JSON while redacting private fields', () => {
  let nested: JsonValue = { text: 'DEEP_END', private: 'PRIVATE_VALUE' };
  for (let index = 0; index < 96; index++) nested = { next: nested };
  const text = JSON.stringify({
    nested,
    entries: Array.from({ length: 200010 }, (_, index) => ({
      text: `entry-${index}`,
    })),
    long: 'x'.repeat(150000) + 'LONG_END',
  });
  const projected = fullEvidenceText(text, 'json');
  assert.match(projected.text, /DEEP_END/);
  assert.match(projected.text, /entry-200009/);
  assert.match(projected.text, /LONG_END/);
  assert.doesNotMatch(projected.text, /PRIVATE_VALUE|omitted-depth-or-size/);
  assert.equal(projected.truncated, false);
  assert.equal(projected.redacted, true);
});

test('Evidence projection accepts explicitly configured byte budgets above 2 MiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-large-evidence-budget-'));
  try {
    const projected = await projectEvidence({
      measurements: [],
      artifacts: new FileArtifacts(root),
      view: 'execution',
      maxBytes: 4 * 1024 * 1024,
    });
    assert.equal(JSON.stringify(projected).includes('"truncated":false'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recorded training projections cannot reintroduce verifier feedback through execution traces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-recorded-training-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new FileArtifacts(root);
  const evidenceIndexRef = await artifacts.putJson({
    entries: [
      {
        access: 'execution',
        kind: 'trajectory',
        integrity: 'complete',
        artifactRef: await artifacts.putJson({
          text: [
            JSON.stringify({ type: 'tool', result: 'visible event' }),
            JSON.stringify({
              type: 'tool',
              result: JSON.stringify({
                view: 'training',
                measurements: [
                  {
                    items: [
                      {
                        evaluation: {
                          diagnostics: [{ message: 'hidden verifier hint' }],
                        },
                      },
                    ],
                  },
                ],
              }),
            }),
            JSON.stringify({
              type: 'tool',
              result: {
                schemaVersion: 'rsi.evaluation-feedback/v1',
                checks: [{ message: 'hidden check' }],
              },
            }),
          ].join('\n'),
        }),
      },
    ],
  });
  const measurements = [
    {
      schemaVersion: 'rsi.measurement/v1',
      ref: 'measurement-training',
      metrics: { latencyMs: 73 },
      evidenceIndexRef,
    },
  ];
  for (const view of ['execution', 'training'] as const) {
    const options = { measurements, artifacts, view };
    const json = object(await projectEvidence(options));
    const files = await projectEvidenceFiles(options);
    for (const result of [json, files]) {
      assert.match(JSON.stringify(result), /visible event/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /hidden verifier hint|hidden check/,
      );
      assert.ok(Array.isArray(result.measurements));
      assert.deepEqual(
        object(result.measurements[0]).metrics,
        view === 'training' ? { latencyMs: 73 } : undefined,
      );
    }
  }
});

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
