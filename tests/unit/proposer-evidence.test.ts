import { environmentSummary } from '../../src/plugins/evaluator-inferencebench/conditions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeContext,
  type ProposerInput,
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { projectEvidenceFiles } from '../../src/runtime/services/facts/evidence-files.js';
import { createProposerAgent } from '../../src/plugins/proposer-agent/service.js';
import { proposerExecutionContext } from '../../src/plugins/proposer-agent/execution-context.js';

test('Proposer can read every non-thinking event and full arguments while only tool-return payloads are shortened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-proposer-evidence-'));
  const artifacts = new FileArtifacts(root);
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected service');
  };
  const context: RuntimeContext = new RuntimeContext().extend({
    experimentId: 'exp',
    callId: 'call',
    bindingId: 'proposer',
    idempotencyKey: 'call',
    directory: root,
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
  });
  try {
    const skill = join(root, 'test-skill');
    const role = join(root, 'scout.md');
    await mkdir(join(skill, 'references'), { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: test-skill\ndescription: A probe skill\n---\nBody',
    );
    await writeFile(join(skill, 'references', 'details.md'), 'Skill reference');
    await writeFile(role, 'Inspect logs independently.');
    const tree = async (files: Record<string, string>) =>
      artifacts.putJson({
        kind: 'file-tree',
        files: Object.entries(files).map(([path, text]) => ({
          path,
          mode: 420,
          base64: Buffer.from(text).toString('base64'),
        })),
      });
    const base = await tree({ 'skill.md': 'Existing skill' });
    const trace = [
      { type: 'status', data: { phase: 'prepare' } },
      { type: 'thinking', data: { text: 'EXCLUDED_THINKING' } },
      ...Array.from({ length: 81 }, (_, n) => ({
        type: 'tool_call',
        data: {
          command: n === 40 ? 'MIDDLE_ACTION' : `action-${n}`,
          payload: 'x'.repeat(4000) + `ARGUMENT_TAIL_${n}`,
          input: { reasoning: 'KEEP_ARGUMENT_REASONING' },
          score: 'HIDDEN_SCORE',
        },
      })),
      {
        type: 'tool_result',
        data: {
          callId: 'call-0',
          status: 'failed',
          result: 'RESULT_PREFIX' + 'y'.repeat(6000) + 'UNSEEN_TOOL_TAIL',
        },
      },
      { type: 'status', data: { phase: 'completed' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    const trajectory = await tree({
      'trajectory.jsonl': trace,
      'session.jsonl': trace,
      'model-settings.yaml': 'EXCLUDED_CONFIGURATION',
      'tool-outputs/validation.txt': 'PUBLIC_TOOL_RESULT',
    });
    const index = await artifacts.putJson({
      entries: [
        {
          kind: 'trajectory',
          access: 'execution',
          integrity: 'complete',
          artifactRef: trajectory,
        },
        {
          kind: 'native-result',
          access: 'private',
          artifactRef: await artifacts.putJson({ text: 'PRIVATE_JUDGE' }),
        },
      ],
    });
    const measurement = {
      schemaVersion: 'rsi.measurement/v1',
      ref: 'm',
      evidenceIndexRef: index,
    };
    let requests = 0,
      commits = 0,
      creates = 0,
      releases = 0;
    let forbidden = false;
    const services: RuntimeContext = new RuntimeContext().extend({
      rootDirectory: root,
      dataDirectory: root,
      artifacts,
      facts: {
        read: async (kind, id) => {
          assert.equal(kind, 'calls');
          assert.equal(id, context.callId);
          return { status: 'running' };
        },
        write: unused,
        list: unused,
      },
      workspaces: {
        create: async () => {
          creates++;
          const directory = join(root, 'edit');
          await mkdir(directory);
          return { ref: 'ws', directory, parentCandidateRef: 'base' };
        },
        read: unused,
        release: async () => {
          releases++;
        },
      },
      readCandidate: async (ref) => ({
        ref,
        artifactRef: base,
        parentRef: null,
        experimentId: 'exp',
      }),
      recordCandidate: unused,
      recordMeasurement: unused,
      readMeasurement: unused,
      application: async () => {
        commits++;
        return {
          action: 'commit',
          status: 'no-change',
          candidateRef: 'base',
          diffRef: null,
        };
      },
      applicationMetadata: async () => ({ target: {} }),
      readEvidence: async (refs, options) => {
        assert.deepEqual(refs, ['m', 'm-source']);
        assert.equal(options?.format, 'files');
        return projectEvidenceFiles({
          measurements: refs.map((ref) => ({ ...measurement, ref })),
          artifacts,
          view: 'execution',
          maxBytes: 2_000_000,
        });
      },
      invokeAgent: async (binding, request) => {
        assert.equal(binding, 'configured-agent');
        requests++;
        assert.deepEqual(Object.keys(request).sort(), [
          'cwd',
          'message',
          'outputSchema',
        ]);
        const cwd = string(request.cwd);
        const instructions = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
        assert.match(instructions, /context\/measurements.json/);
        assert.match(
          await readFile(join(cwd, '.codex/agents/scout.toml'), 'utf8'),
          /Inspect logs independently/,
        );
        assert.match(
          await readFile(join(cwd, 'roles/scout.md'), 'utf8'),
          /Inspect logs independently/,
        );
        assert.equal(
          await readFile(
            join(cwd, '.agents/skills/test-skill/references/details.md'),
            'utf8',
          ),
          'Skill reference',
        );
        const evidence = object(
          JSON.parse(
            await readFile(join(cwd, 'context/measurements.json'), 'utf8'),
          ),
        );
        assert.equal(evidence.view, 'execution');
        const measurements = evidence.measurements as Array<{
          supplementaryPath: string;
        }>;
        assert.equal(measurements.length, 2);
        const path = measurements[0]!.supplementaryPath;
        const complete = await readFile(join(cwd, path), 'utf8');
        assert.doesNotMatch(
          instructions + JSON.stringify(evidence) + complete,
          /HIDDEN_SCORE|PRIVATE_JUDGE|EXCLUDED_CONFIGURATION|EXCLUDED_THINKING|UNSEEN_TOOL_TAIL/,
        );
        assert.equal((complete.match(/"type":"tool_call"/g) ?? []).length, 81);
        assert.match(complete, /ARGUMENT_TAIL_40/);
        assert.match(complete, /KEEP_ARGUMENT_REASONING/);
        assert.match(complete, /RESULT_PREFIX/);
        assert.match(complete, /"phase":"prepare"/);
        assert.match(complete, /"phase":"completed"/);
        assert.match(complete, /"status":"failed"/);
        assert.match(
          complete.split('\n').slice(0, 200).join('\n'),
          /MIDDLE_ACTION/,
        );
        assert.match(complete, /PUBLIC_TOOL_RESULT/);
        return {
          edits: forbidden
            ? [{ op: 'replace', path, content: 'overwrite evidence' }]
            : [],
          reason: 'No supported edit.',
        };
      },
      invoke: unused,
      withInstance: unused,
      charge: unused,
    });
    const operation = await createProposerAgent(
      {
        prompt: 'src/policies/harness2/prompts/invariant.md',
        agentRef: 'configured-agent',
        skills: [skill],
        subagents: [{ name: 'scout', description: 'Read logs', prompt: role }],
      },
      services,
    );
    const input: ProposerInput = {
      parent: 'base',
      goal: 'Improve workflow',
      evidenceRefs: ['m'],
      sources: [{ candidateRef: 'source', measurementRef: 'm-source' }],
    };
    assert.equal(
      object(await operation.execute(input, context.extend(services))).status,
      'no-change',
    );
    forbidden = true;
    await assert.rejects(
      operation.execute(input, context.extend(services)),
      /read.only/i,
    );
    assert.equal(requests, 3);
    assert.equal(commits, 1);
    assert.equal(creates, 1);
    assert.equal(releases, 1);
    await operation.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Proposer preserves separate attempts, malformed lines, nested assistant text and explicit missing sources', () => {
  const result = proposerExecutionContext({
    schemaVersion: 'rsi.evidence-files/v1',
    view: 'execution',
    files: {
      first: JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'DROP_NESTED_THINKING' },
          { type: 'text', text: 'KEEP_ASSISTANT_TEXT' },
        ],
      }),
      duplicate: JSON.stringify({
        type: 'text',
        text: 'DO_NOT_DUPLICATE_SESSION',
      }),
      second:
        'invalid-json-source-line\n' +
        JSON.stringify({ type: 'end', data: { reason: 'SECOND_ATTEMPT_END' } }),
      empty: '',
    },
    measurements: [
      {
        measurementRef: 'm',
        entries: [
          {
            kind: 'trajectory',
            attemptId: 'one',
            integrity: 'complete',
            files: [
              { path: 'first', source: { path: 'trajectory.jsonl' } },
              { path: 'duplicate', source: { path: 'session.jsonl' } },
            ],
          },
          {
            kind: 'trajectory',
            attemptId: 'two',
            integrity: 'partial',
            files: [{ path: 'second', source: { path: 'session.jsonl' } }],
          },
          { kind: 'trajectory', integrity: 'missing', files: [] },
          {
            kind: 'trajectory',
            integrity: 'partial',
            files: [{ path: 'empty', source: { path: 'trajectory.jsonl' } }],
          },
        ],
      },
    ],
  });
  const packet = String(result.files['context/runs/0.txt']);
  assert.match(packet, /KEEP_ASSISTANT_TEXT/);
  assert.match(packet, /invalid-json-source-line/);
  assert.match(packet, /SECOND_ATTEMPT_END/);
  assert.doesNotMatch(packet, /DROP_NESTED_THINKING|DO_NOT_DUPLICATE_SESSION/);
  const measurements = object(result.evidence).measurements;
  assert.ok(Array.isArray(measurements));
  const measurement = object(measurements[0]);
  assert.ok(Array.isArray(measurement.attempts));
  assert.deepEqual(
    measurement.attempts.map((a) => object(a).eventsProvided),
    [1, 2, 0],
  );
  assert.match(JSON.stringify(measurement.unavailable), /no-canonical-trace/);
  assert.match(JSON.stringify(measurement.attempts), /partial/);
});

test('Tool-return prefixes preserve Unicode and failure identity without shortening tool calls', () => {
  const result = proposerExecutionContext({
    schemaVersion: 'rsi.evidence-files/v1',
    view: 'execution',
    files: {
      trace: JSON.stringify({
        type: 'tool_result',
        data: {
          callId: 'failed-call',
          status: 'failed',
          result: { exitCode: 3, output: '界'.repeat(4000) + 'UNREAD_TAIL' },
        },
      }),
    },
    measurements: [
      {
        measurementRef: 'm',
        entries: [
          {
            kind: 'trajectory',
            integrity: 'complete',
            files: [{ path: 'trace', source: { path: 'trajectory.jsonl' } }],
          },
        ],
      },
    ],
  });
  const packet = String(result.files['context/runs/0.txt']);
  const line = packet.split('\n').find((line) => line.startsWith('L1: '));
  assert.ok(line);
  const event = object(JSON.parse(line.slice(4)));
  const data = object(event.data);
  const payload = object(data.result);
  assert.equal(data.callId, 'failed-call');
  assert.equal(data.status, 'failed');
  assert.equal(payload.exitCode, 3);
  assert.equal(payload.truncated, true);
  assert.equal(Array.from(String(payload.preview)).length, 2000);
  assert.doesNotMatch(packet, /UNREAD_TAIL|\uFFFD/);
});

test('training Proposer receives complete runs, authorized feedback and metric environments for an evidence reference', async (t) => {
  const secret = 'credential-in-allowed-field';
  const previous = process.env.PROPOSER_TEST_SECRET;
  process.env.PROPOSER_TEST_SECRET = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.PROPOSER_TEST_SECRET;
    else process.env.PROPOSER_TEST_SECRET = previous;
  });
  const root = await mkdtemp(join(tmpdir(), 'metric-evidence-'));
  const artifacts = new FileArtifacts(root);
  try {
    const definitionRef = await artifacts.putJson({
      id: 'throughput',
      unit: 'tokens/s',
      description: `Generated on ${secret}`,
      valueKind: 'scalar',
    });
    const summary = environmentSummary({
      fixed: {
        serviceResources: {
          software: `engine-1.0 ${secret}`,
          devices: ['0', '1'],
          verified: true,
          host: 'PRIVATE',
        },
        config: {
          benchmark: {
            name: 'aisbench',
            config: {
              workload: {
                concurrency: 330,
                inputLength: 4096,
                token: 'PRIVATE',
              },
            },
            solver: { password: 'PRIVATE' },
          },
        },
        identity: null,
      },
    });
    assert.deepEqual(summary.workload, { concurrency: 330, inputLength: 4096 });
    const environmentRef = await artifacts.putJson(summary);
    const metrics = {
      throughput: {
        definitionRef,
        status: 'available',
        value: { kind: 'scalar', value: 4588.57 },
      },
    };
    const trace = await artifacts.putJson({
      text: JSON.stringify({ type: 'tool_call', command: 'FULL_RUN' }),
    });
    const evidenceIndexRef = await artifacts.putJson({
      entries: [
        { kind: 'trajectory', access: 'execution', artifactRef: trace },
      ],
    });
    const feedback = {
      schemaVersion: 'rsi.evaluation-feedback/v1',
      itemId: 'item',
      attemptId: null,
      executionStatus: 'succeeded',
      scoreStatus: 'valid',
      passed: true,
      primaryReward: null,
      passThreshold: null,
      checks: [],
      checksComplete: true,
      diagnostics: [],
      truncated: false,
      source: { artifactRef: trace, pointer: '' },
    };
    const itemsRef = await artifacts.putJson({
      items: [
        {
          id: 'item',
          metrics,
          evaluation: { artifactRef: await artifacts.putJson(feedback) },
        },
      ],
    });
    const measurement = {
      schemaVersion: 'rsi.measurement/v1',
      ref: 'm',
      candidateRef: 'c',
      status: 'succeeded',
      coverage: 'complete',
      comparisonKey: 'same-load',
      metrics,
      evidenceIndexRef,
      itemsRef,
      profile: { secret: 'PRIVATE' },
      extensions: [
        {
          schemaId: 'measurement.environment-summary/v1',
          artifactRef: environmentRef,
          schemaDigest: 'unused',
        },
      ],
    };
    const candidate = await artifacts.putJson({ kind: 'file-tree', files: [] });
    const context = new RuntimeContext().extend({
      directory: root,
      artifacts,
      readCandidate: async (ref) => ({
        ref,
        artifactRef: candidate,
        parentRef: null,
        experimentId: 'exp',
      }),
      applicationMetadata: async () => ({}),
      readMeasurement: async (ref) => {
        assert.equal(ref, measurement.ref);
        return measurement;
      },
      readEvidence: async (refs, options) => {
        assert.deepEqual(refs, ['evidence-window', 'm']);
        assert.deepEqual(options, { format: 'files', view: 'training' });
        return projectEvidenceFiles({
          artifacts,
          measurements: [measurement, measurement],
          view: 'training',
        });
      },
      invokeAgent: async (_, request) => {
        const cwd = string(request.cwd);
        const metadata = object(
          JSON.parse(await readFile(join(cwd, 'context/input.json'), 'utf8')),
        );
        assert.equal(metadata.metricEvidencePath, 'context/metrics.json');
        assert.match(string(metadata.metricEvidenceInstruction), /environment/);
        const evidence = object(
          JSON.parse(
            await readFile(join(cwd, 'context/measurements.json'), 'utf8'),
          ),
        );
        assert.equal(evidence.view, 'training');
        assert.ok(Array.isArray(evidence.measurements));
        const row = object(evidence.measurements[0]);
        assert.deepEqual(row.metrics, metrics);
        assert.ok(Array.isArray(row.items));
        assert.deepEqual(object(row.items[0]).evaluation, feedback);
        assert.equal(
          object(object(row.metricDefinitions)[definitionRef]).unit,
          'tokens/s',
        );
        assert.deepEqual(
          [row.omittedItems, row.itemsTruncated, row.metricDefinitionsOmitted],
          [0, false, false],
        );
        assert.equal(row.supplementaryPath, 'context/runs/0.txt');
        const run = await readFile(join(cwd, row.supplementaryPath), 'utf8');
        assert.match(run, /FULL_RUN/);
        const metricFile = await readFile(
          join(cwd, metadata.metricEvidencePath),
          'utf8',
        );
        const metricIndex = object(JSON.parse(metricFile));
        assert.ok(Array.isArray(metricIndex.measurements));
        assert.equal(metricIndex.measurements.length, 1);
        assert.equal(
          object(object(metricIndex.metricDefinitions)[definitionRef]).unit,
          'tokens/s',
        );
        assert.match(metricFile, /4588.57/);
        assert.match(metricFile, /engine-1.0 \[REDACTED\]/);
        assert.doesNotMatch(
          metricFile + JSON.stringify(evidence) + run,
          /PRIVATE|credential-in-allowed-field/,
        );
        return { proposals: [] };
      },
    });
    const proposer = await createProposerAgent(
      {
        prompt: 'src/policies/harness2/prompts/invariant.md',
        evidenceView: 'training',
      },
      context,
    );
    try {
      const result = await proposer.execute(
        {
          parent: 'c',
          goal: 'Improve throughput',
          evidenceRefs: ['evidence-window', 'm'],
          maxCandidates: 1,
        },
        context,
      );
      assert.equal(result.status, 'no-change');
    } finally {
      await proposer.dispose();
    }
    assert.deepEqual(
      environmentSummary({ fixed: { config: null, serviceResources: null } }),
      {
        software: null,
        devices: null,
        resourcesVerified: false,
        workload: {},
        benchmark: null,
        identity: null,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
