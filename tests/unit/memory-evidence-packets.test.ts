import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executionEvidencePackets,
  excerpt,
} from '../../src/plugins/shared/agent-editing/evidence-packets.js';

test('Memory packet surfaces middle errors, excludes configuration and keeps bounded supplementary provenance', () => {
  const lines = Array.from({ length: 100 }, (_, n) =>
    JSON.stringify({
      type: n === 50 ? 'error' : 'tool_call',
      data: { message: n === 50 ? 'MIDDLE_FAILURE' : 'operation ' + n },
    }),
  ).join('\n');
  const result = executionEvidencePackets({
    files: {
      trace: lines,
      settings: 'SHOULD_NOT_EXPOSE',
      empty: '',
      final: 'delivered',
    },
    measurements: [
      {
        measurementRef: 'm',
        entries: [
          {
            kind: 'trajectory',
            files: [
              {
                path: 'trace',
                source: {
                  path: 'trajectory.jsonl',
                  artifactRef: 'artifact:trace',
                },
              },
              { path: 'settings', source: { path: 'model-settings.yaml' } },
              { path: 'empty', source: { path: 'stderr.log' } },
            ],
          },
          { kind: 'final-text', files: [{ path: 'final' }] },
        ],
      },
    ],
  });
  assert.match(JSON.stringify(result.evidence), /MIDDLE_FAILURE/);
  assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_EXPOSE/);
  assert.equal(Object.keys(result.files).length, 1);
  assert.match(JSON.stringify(result.evidence), /artifact:trace/);
});

test('Memory packet declares missing binaries and excerpt omissions without inventing contents', () => {
  const result = executionEvidencePackets({
    files: {},
    measurements: [
      {
        measurementRef: 'm',
        entries: [
          {
            kind: 'delivery',
            files: [
              { source: { path: 'output.pptx' }, inspection: 'uninspected' },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(result.files, {});
  assert.match(JSON.stringify(result.evidence), /uninspected/);
  const clipped = excerpt('开始'.repeat(1000) + '结束', 1000);
  assert.ok(Buffer.byteLength(clipped) <= 1000);
  assert.match(clipped, /omitted/);
  assert.ok(clipped.endsWith('结束'));
});
