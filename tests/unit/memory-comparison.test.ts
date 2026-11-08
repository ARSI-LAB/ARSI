import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type JsonObject,
  type MemoryInput,
} from '../../src/contracts/index.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { projectEvidenceFiles } from '../../src/runtime/services/facts/evidence-files.js';
import { buildComparisonContext } from '../../src/plugins/memory-agent/comparison.js';
import { editResource } from '../../src/plugins/shared/agent-editing/index.js';
import { createMemoryAgent } from '../../src/plugins/memory-agent/service.js';
import { string } from '../../src/shared/json.js';

const context: RuntimeContext = new RuntimeContext().extend({
  experimentId: 'exp',
  callId: 'call',
  bindingId: 'memory',
  idempotencyKey: 'call',
  directory: '/unused',
  signal: new AbortController().signal,
  cleanup: new AbortController().signal,
});

test('Memory reconciles only failed calls that never invoked a child operation', async () => {
  let children: JsonObject[] = [];
  const runtime = context.extend({
    facts: {
      list: async () => children,
      read: async () => {
        throw new Error('Unexpected fact read');
      },
      write: async () => {
        throw new Error('Reconciliation must not write facts');
      },
    },
  });
  const operation = await createMemoryAgent({ prompt: 'unused' }, runtime);
  assert.equal(typeof operation.canRetry, 'function');
  const receipt = {
    callId: 'memory-call',
    status: 'failed',
    experimentId: 'exp',
  };
  const input: MemoryInput = {
    goal: 'test',
    memoryRef: null,
    evidenceRefs: [],
  };
  assert.equal(await operation.canRetry!(input, receipt, runtime), true);
  children = [{ parentCallId: 'memory-call', status: 'succeeded' }];
  assert.equal(await operation.canRetry!(input, receipt, runtime), false);
  children = [{ parentCallId: 'another-call' }];
  assert.equal(await operation.canRetry!(input, receipt, runtime), true);
  for (const status of ['unknown', 'running', 'cancelled']) {
    assert.equal(
      await operation.canRetry!(input, { ...receipt, status }, runtime),
      false,
    );
  }
});

test('Memory receives inline diffs and bounded execution packets without duplicate files or private scoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-memory-comparison-'));
  const artifacts = new FileArtifacts(root);
  try {
    const tree = async (text: string) =>
      artifacts.putJson({
        kind: 'file-tree',
        files: [
          {
            path: 'skill.md',
            mode: 420,
            base64: Buffer.from(text).toString('base64'),
          },
        ],
      });
    const base = await tree('old action\n');
    const candidate = await tree('new action\n');
    const records = Array.from({ length: 240 }, (_, n) =>
      JSON.stringify({
        step: n,
        action: n === 101 ? 'MIDDLE_PROBE_EVENT' : 'tool',
        score: 0.999,
        private: { answer: 'PRIVATE_ANSWER' },
      }),
    ).join('\n');
    const trajectory = await artifacts.putJson({
      kind: 'file-tree',
      files: Array.from({ length: 12 }, (_, n) => ({
        path:
          n === 0
            ? 'trajectory.jsonl'
            : n === 1
              ? 'session.jsonl'
              : `tool-outputs/trace-${n}.jsonl`,
        mode: 420,
        base64: Buffer.from(records).toString('base64'),
      })),
    });
    const privateRef = await artifacts.putJson({ score: 'PRIVATE_SCORE' });
    const index = await artifacts.putJson({
      entries: [
        {
          kind: 'trajectory',
          access: 'execution',
          integrity: 'complete',
          artifactRef: trajectory,
          itemId: 'task',
          attemptId: 'attempt',
        },
        {
          kind: 'native-result',
          access: 'private',
          integrity: 'complete',
          artifactRef: privateRef,
        },
      ],
    });
    const measurements = ['m-base', 'm-inv', 'm-dom', 'm-compose'].map(
      (ref, n) => ({
        schemaVersion: 'rsi.measurement/v1',
        ref,
        candidateRef: n === 0 ? 'base' : 'candidate',
        experimentId: 'exp',
        status: 'succeeded',
        coverage: 'complete',
        evidenceIndexRef: index,
      }),
    );
    const decisionRef = await artifacts.putJson({
      kind: 'artifact-decision',
      candidates: [
        {
          candidateRef: 'candidate',
          measurementRef: 'm-compose',
          originalIndex: 0,
        },
      ],
      selectedIndex: 0,
      reason: 'Usable output',
    });
    let workspaceCreates = 0;
    const services: RuntimeContext = new RuntimeContext().extend({
      rootDirectory: root,
      dataDirectory: root,
      directory: root,
      artifacts,
      facts: {
        read: async () => ({}),
        write: async () => {},
        list: async () => [],
      },
      workspaces: {
        create: async () => {
          workspaceCreates++;
          const directory = join(root, 'workspace');
          await mkdir(directory, { recursive: true });
          return { ref: 'ws', directory, parentCandidateRef: null };
        },
        read: async () => ({
          ref: 'ws',
          directory: root,
          parentCandidateRef: null,
        }),
        release: async () => {},
      },
      readCandidate: async (ref) => {
        assert.ok(['base', 'candidate'].includes(ref));
        return {
          ref,
          artifactRef: ref === 'base' ? base : candidate,
          parentRef: null,
          experimentId: 'exp',
        };
      },
      recordCandidate: async () => 'candidate',
      recordMeasurement: async () => 'measurement',
      readMeasurement: async (ref) => {
        const m = measurements.find((m) => m.ref === ref);
        assert.ok(m);
        return m;
      },
      readEvidence: async (refs, options) => {
        assert.equal(options?.format, 'files');
        return projectEvidenceFiles({
          measurements: measurements.filter((m) => refs.includes(m.ref)),
          artifacts,
          view: 'execution',
          maxBytes: 32 * 1024 * 1024,
        });
      },
      application: async () => ({}),
      applicationMetadata: async () => ({}),
      invokeAgent: async () => ({
        edits: [{ path: 'context/index.json', content: 'tampered' }],
        reason: 'bad',
      }),
      invoke: async () => ({}),
      charge: async () => {},
      withInstance: async (_ref, _cap, use) => use({}),
    });
    const input: MemoryInput = {
      memoryRef: null,
      goal: 'Learn from edits',
      evidenceRefs: ['m-base'],
      comparison: {
        baselineCandidateRef: 'base',
        probes: {
          base: [{ candidateRef: 'base', measurementRef: 'm-base', slot: 0 }],
          inv: [{ candidateRef: 'candidate', measurementRef: 'm-inv' }],
          dom: [{ candidateRef: 'candidate', measurementRef: 'm-dom' }],
          compose: [{ candidateRef: 'candidate', measurementRef: 'm-compose' }],
        },
        selection: {
          candidateRef: 'candidate',
          measurementRef: 'm-compose',
          decisionRef,
        },
      },
    };
    const result = await buildComparisonContext(
      input,
      context.extend(services),
    );
    const visible = JSON.stringify(result);
    assert.equal(
      Object.keys(result.files).some((p) =>
        /comparison\/candidates|index\.json|session/.test(p),
      ),
      false,
    );
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({ input: result.input, evidence: result.evidence }),
      ) < 40000,
    );
    assert.match(JSON.stringify(result.evidence), /excerpts/);
    assert.match(JSON.stringify(result.input), /-old action/);
    assert.match(visible, /MIDDLE_PROBE_EVENT/);
    assert.match(visible, /-old action/);
    assert.match(visible, /\+new action/);
    assert.match(visible, /Usable output/);
    assert.doesNotMatch(visible, /PRIVATE_ANSWER|PRIVATE_SCORE|0\.999/);
    assert.equal(
      Object.keys(result.files).filter((path) =>
        path.startsWith('context/runs/'),
      ).length,
      4,
    );
    assert.equal(
      (result.input.comparison as JsonObject).selectedCandidateRef,
      'candidate',
    );
    await assert.rejects(
      editResource(
        { prompt: 'src/policies/harness2/memory.md' },
        input,
        null,
        context.extend(services),
        result,
      ),
      /read.only/i,
    );
    assert.equal(workspaceCreates, 0);
    services.invokeAgent = async (_binding, request) => {
      const directory = join(string(request.cwd), 'context');
      await assert.rejects(readFile(join(directory, 'index.json')), {
        code: 'ENOENT',
      });
      const input = JSON.parse(
        await readFile(join(directory, 'input.json'), 'utf8'),
      );
      assert.match(JSON.stringify(input.comparison), /old action/);
      assert.match(
        await readFile(join(directory, 'measurements.json'), 'utf8'),
        /excerpts/,
      );
      assert.ok((await readdir(join(directory, 'runs'))).length <= 4);
      return {
        edits: [
          {
            path: 'experiences/pattern.md',
            content: 'Observed contrast, with confounded attribution.',
          },
        ],
        reason: 'Evidence',
      };
    };
    const operation = await createMemoryAgent(
      { prompt: 'src/policies/harness2/memory.md' },
      services,
    );
    const updated = (await operation.execute(
      input,
      context.extend(services),
    )) as JsonObject;
    const snapshot = (await artifacts.readJson(
      updated.memoryRef as string,
    )) as JsonObject;
    assert.equal((snapshot.files as JsonObject[]).length, 1);
    assert.equal(
      (snapshot.files as JsonObject[])[0].path,
      'experiences/pattern.md',
    );
    const bad = structuredClone(input);
    ((bad.comparison as JsonObject).selection as JsonObject).measurementRef =
      'm-base';
    await assert.rejects(
      buildComparisonContext(bad, context.extend(services)),
      /selection|selected/i,
    );
    const mismatch = structuredClone(input);
    (
      ((mismatch.comparison as JsonObject).probes as JsonObject)
        .inv as JsonObject[]
    )[0].candidateRef = 'base';
    await assert.rejects(
      buildComparisonContext(mismatch, context.extend(services)),
      /measurement.*candidate|candidate.*measurement/i,
    );
    await assert.rejects(
      projectEvidenceFiles({
        measurements,
        artifacts,
        view: 'execution',
        maxBytes: 100,
      }),
      /size|byte|limit/i,
    );
    await assert.rejects(
      projectEvidenceFiles({
        measurements,
        artifacts,
        view: 'delivery',
        maxBytes: 10000,
      }),
      /execution/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
