import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSync, resetSync, type LogRecord } from '@logtape/logtape';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  evaluationFeedbackSchema,
  metricDefinitionSchema,
  validateMeasurement,
} from '../../src/contracts/models/measurement.js';
import { projectEvidence } from '../../src/runtime/services/facts/evidence.js';
import { validate } from '../../src/shared/schema.js';
import {
  createGym,
  resolveGymConfig,
} from '../../src/plugins/evaluator-gym/evaluate/service.js';
import type { GymConfig } from '../../src/plugins/evaluator-gym/evaluate/schema.js';

const BUNDLE_DIGEST = `sha256:${'c'.repeat(64)}`;
const ENVIRONMENT_DIGEST = `sha256:${'b'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;

test('gym config resolves environment references at the plugin boundary', () => {
  const config: GymConfig = {
    baseUrl: '${GYM_BASE_URL}',
    requestDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      split: 'train_full',
      tier: 'screen',
      seed: 42,
    },
  };
  assert.deepEqual(
    resolveGymConfig(config, {
      GYM_BASE_URL: 'http://127.0.0.1:8399',
    }),
    {
      baseUrl: 'http://127.0.0.1:8399',
      requestDefaults: config.requestDefaults,
    },
  );
});

test('gym config rejects a missing environment reference', () => {
  const config: GymConfig = {
    baseUrl: '${MISSING_GYM_URL}',
    requestDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      split: 'train_full',
      tier: 'screen',
      seed: 42,
    },
  };
  assert.throws(
    () => resolveGymConfig(config, {}),
    /gym baseUrl references missing environment variable MISSING_GYM_URL/,
  );
});

interface Execution {
  directory: string;
  bundleDigest: string;
  bundleKind?: string;
  artifactDigest: string;
}

interface Harness {
  services: RuntimeContext;
  stored: Map<string, JsonValue>;
  measurements: JsonObject[];
  charges: string[];
  facts: Map<string, JsonObject>;
}

function harness(
  root: string,
  execution: Execution,
  options: { failFactWrites?: readonly number[] } = {},
): Harness {
  const stored = new Map<string, JsonValue>();
  const facts = new Map<string, JsonObject>();
  const measurements: JsonObject[] = [];
  const charges: string[] = [];
  let factWrites = 0;
  const services: RuntimeContext = new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: root,
    artifacts: {
      putJson: async (value) => {
        const ref = `artifact:${stored.size}`;
        stored.set(ref, structuredClone(value) as JsonValue);
        return ref;
      },
      readJson: async (ref) => {
        const value = stored.get(ref);
        if (value === undefined) throw new Error(`missing artifact ${ref}`);
        return structuredClone(value);
      },
      capture: async () => 'artifact:tree',
      materialize: async () => {},
    },
    facts: {
      read: async (kind, id) => {
        const value = facts.get(`${kind}/${id}`);
        if (value === undefined)
          throw Object.assign(new Error('missing fact'), { code: 'ENOENT' });
        return structuredClone(value);
      },
      write: async (kind, id, value) => {
        factWrites++;
        if (options.failFactWrites?.includes(factWrites))
          throw new Error(`fixture fact write ${factWrites} failed`);
        facts.set(`${kind}/${id}`, structuredClone(value));
      },
      list: async () => [],
    },
    workspaces: {
      create: async () => ({
        ref: 'ws',
        directory: root,
        parentCandidateRef: null,
      }),
      read: async () => ({
        ref: 'ws',
        directory: root,
        parentCandidateRef: null,
      }),
      release: async () => {},
    },
    readCandidate: async () => ({
      ref: 'candidate:a',
      artifactRef: execution.artifactDigest,
      parentRef: null,
      experimentId: 'exp',
    }),
    recordCandidate: async () => 'candidate:a',
    recordMeasurement: async (measurement) => {
      validateMeasurement(measurement);
      measurements.push(measurement);
      return `measurement:${measurements.length}`;
    },
    readMeasurement: async () => ({}),
    application: async () => ({}),
    applicationMetadata: async () => ({}),
    invokeAgent: async () => ({}),
    readEvidence: async () => [],
    invoke: async () => ({}),
    charge: async (metric) => {
      charges.push(metric);
    },
    withInstance: async (_candidate, _capability, use) => use({ ...execution }),
  });
  return { services, stored, measurements, charges, facts };
}

function context(
  root: string,
  services: RuntimeContext,
  callId = 'call',
): RuntimeContext {
  return new RuntimeContext()
    .extend({
      directory: root,
      experimentId: 'exp',
      callId,
      bindingId: 'evaluator',
      idempotencyKey: callId,
      signal: new AbortController().signal,
      cleanup: new AbortController().signal,
    })
    .extend(services);
}

interface FakeGymOptions {
  status?: 'completed' | 'failed' | 'rejected';
  trusted?: boolean | null;
  queuedResultPolls?: number;
  missingResultPolls?: number;
  dropSubmitResponseOnce?: boolean;
  items?: JsonValue[];
  rollouts?: number;
  rolloutsFailed?: number;
  rolloutsAttempted?: number | null;
  rewardMean?: number;
  passRate?: number;
  resultCandidateDigest?: string | null;
  warnings?: string[];
  evaluationDigest?: string;
  manifestSchemaVersion?: number;
}

async function fakeGym(options: FakeGymOptions = {}): Promise<{
  baseUrl: string;
  submissions: JsonObject[];
  submitCount: () => number;
  resultCount: () => number;
  setEvaluationDigest: (value: string) => void;
  close: () => Promise<void>;
}> {
  const submissions: JsonObject[] = [];
  const submittedTasks = new Map<string, string[]>();
  const submittedDigests = new Map<string, string>();
  let dropSubmitResponse = options.dropSubmitResponseOnce ?? false;
  let evaluationDigest = options.evaluationDigest ?? `sha256:${'d'.repeat(64)}`;
  const missingResultPolls = options.missingResultPolls ?? 0;
  let resultCount = 0;
  const server = createServer(async (request, response) => {
    const input = await requestBody(request);
    if (request.url === '/gym_evaluate') {
      submissions.push(input);
      const rejected = options.status === 'rejected';
      const evalId = `eval-${String(submissions.length).padStart(16, '0')}`;
      const taskIds = Array.isArray(input.task_ids)
        ? input.task_ids.map((taskId) => String(taskId))
        : [];
      submittedTasks.set(evalId, taskIds);
      submittedDigests.set(evalId, String(input.candidate_digest ?? ''));
      if (dropSubmitResponse) {
        dropSubmitResponse = false;
        response.destroy();
        return;
      }
      reply(response, 200, {
        eval_id: evalId,
        status: rejected ? 'rejected' : 'queued',
        ...(rejected
          ? {
              error: {
                code: 'HOLDOUT_LOCKED',
                message: 'fixture rejection',
                fix_hint: 'use train_probe',
              },
            }
          : {}),
      });
      return;
    }
    if (request.url === '/results') {
      resultCount++;
      if (resultCount <= missingResultPolls) {
        reply(response, 200, { found: false });
        return;
      }
      if (
        resultCount <=
        missingResultPolls + (options.queuedResultPolls ?? 0)
      ) {
        reply(response, 200, {
          found: true,
          result: {
            eval_id: input.eval_id,
            status: 'queued',
            ...(options.rolloutsAttempted === undefined
              ? {}
              : { metrics: { rollouts_attempted: options.rolloutsAttempted } }),
          },
        });
        return;
      }
      const evalId = String(input.eval_id);
      const taskIds = submittedTasks.get(evalId) ?? [];
      const rewardMean =
        options.rewardMean ?? (options.status === 'failed' ? null : 0.75);
      const passRate =
        options.passRate ?? (options.status === 'failed' ? null : 0.5);
      const successful =
        options.rollouts ?? (options.status === 'failed' ? 0 : taskIds.length);
      const failed = options.rolloutsFailed ?? 0;
      const attempted =
        options.rolloutsAttempted === undefined
          ? successful + failed
          : options.rolloutsAttempted;
      const candidateDigest =
        options.resultCandidateDigest === undefined
          ? (submittedDigests.get(evalId) ?? '')
          : options.resultCandidateDigest;
      const trusted = options.trusted === undefined ? true : options.trusted;
      const items =
        options.items ??
        taskIds.map((taskId) => ({
          task_id: taskId,
          rollouts: 1,
          reward_mean: rewardMean,
          pass_rate: passRate,
          rollouts_failed: 0,
          checks: [
            {
              id: 'answer-match/0',
              status: (passRate ?? 0) >= 1 ? 'passed' : 'failed',
              score: rewardMean,
              reason: null,
            },
          ],
          diagnostics: [],
          truncated: false,
        }));
      reply(response, 200, {
        found: true,
        result: {
          eval_id: evalId,
          ...(candidateDigest === null
            ? {}
            : { candidate_digest: candidateDigest }),
          status: options.status ?? 'completed',
          metrics: {
            reward_mean: rewardMean,
            pass_rate: passRate,
            rollouts: successful,
            rollouts_failed: failed,
            ...(attempted === null ? {} : { rollouts_attempted: attempted }),
          },
          ...(trusted === null ? {} : { overfit_guard: { trusted } }),
          experiment_profile_id: 'fixture-profile',
          dataset_version: 'fixture-dataset-v1',
          manifest_schema_version: options.manifestSchemaVersion ?? 2,
          harness_manifest_digest: MANIFEST_DIGEST,
          environment_digest: ENVIRONMENT_DIGEST,
          evaluation_digest: evaluationDigest,
          per_rollout_ref: '/fixture/rollouts.jsonl',
          items,
          cost: { total_tokens: 42, wall_time_s: 1.5 },
          warnings: options.warnings ?? [],
        },
      });
      return;
    }
    reply(response, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    submissions,
    submitCount: () => submissions.length,
    resultCount: () => resultCount,
    setEvaluationDigest: (value) => {
      evaluationDigest = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function requestBody(request: IncomingMessage): Promise<JsonObject> {
  let value = '';
  for await (const chunk of request) value += String(chunk);
  const parsed: unknown = JSON.parse(value);
  assert.ok(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
  );
  return parsed as JsonObject;
}

function reply(
  response: ServerResponse,
  status: number,
  value: JsonObject,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

async function bundle(root: string): Promise<Execution> {
  const directory = join(root, 'bundle');
  await mkdir(join(directory, 'plugins', 'fixture'), { recursive: true });
  await writeFile(
    join(directory, 'plugins', 'fixture', 'instruction.md'),
    'v1',
  );
  return {
    directory,
    bundleDigest: BUNDLE_DIGEST,
    bundleKind: 'dsh-agent-bundle',
    artifactDigest: 'artifact:candidate',
  };
}

function config(baseUrl: string): GymConfig {
  return {
    baseUrl,
    requestDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      split: 'train_probe',
      tier: 'probe',
      seed: 42,
    },
    poll: { intervalMs: 100, timeoutMs: 5_000 },
  };
}

test('gym evaluator sends the candidate directory and kind, submits its digest, and records comparable metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-evaluator-'));
  const gym = await fakeGym();
  const execution = await bundle(root);
  const { services, measurements, stored, charges } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    const output = await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services),
    );
    assert.deepEqual(output, { measurementRef: 'measurement:1' });
    assert.equal(gym.submitCount(), 1);
    assert.equal(gym.submissions[0]!.candidate_digest, BUNDLE_DIGEST);
    assert.deepEqual(gym.submissions[0]!.task_ids, ['task/a']);
    assert.equal(gym.submissions[0]!.candidate_dir, execution.directory);
    assert.equal(gym.submissions[0]!.candidate_kind, 'dsh-agent-bundle');
    assert.deepEqual(charges, ['evaluationRuns']);
    const measurement = measurements[0]!;
    assert.equal(measurement.status, 'succeeded');
    assert.equal(measurement.coverage, 'complete');
    assert.equal(typeof measurement.comparisonKey, 'string');
    const metrics = measurement.metrics as JsonObject;
    const reward = metrics.meanReward as JsonObject;
    assert.equal(reward.status, 'available');
    assert.deepEqual(reward.value, { kind: 'scalar', value: 0.75 });
    validate(
      metricDefinitionSchema,
      stored.get(String(reward.definitionRef)),
      'fixture metric definition',
    );
    const conditions = stored.get(
      String((measurement.conditions as JsonObject).artifactRef),
    ) as JsonObject;
    assert.equal(conditions.known, true);
    assert.ok(Array.isArray(conditions.candidateFactors));
    assert.deepEqual(conditions.candidateFactors, [
      'candidateRef',
      'bundleDigest',
    ]);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym evaluator counts failed rollouts as zero and keeps the evaluation comparable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-failures-'));
  const gym = await fakeGym({
    rollouts: 1,
    rolloutsFailed: 1,
    rolloutsAttempted: 2,
    rewardMean: 0.5,
    passRate: 0.5,
    items: [
      {
        task_id: 'task/a',
        rollouts: 1,
        reward_mean: 1,
        pass_rate: 1,
        rollouts_failed: 0,
        checks: [
          {
            id: 'answer-match/0',
            status: 'passed',
            score: 1,
            reason: null,
          },
        ],
        diagnostics: [],
        truncated: false,
      },
      {
        task_id: 'task/b',
        rollouts: 0,
        reward_mean: null,
        pass_rate: null,
        rollouts_failed: 1,
        checks: [
          {
            id: 'execution',
            status: 'failed',
            score: 0,
            reason: 'dsh did not finish within 300s',
          },
        ],
        diagnostics: [
          {
            kind: 'gym-execution',
            code: 'rollout_failure',
            message: 'dsh did not finish within 300s',
            truncated: false,
          },
        ],
        truncated: false,
      },
    ],
  });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a', 'task/b'] },
      context(root, services),
    );
    const measurement = measurements[0]!;
    assert.equal(measurement.status, 'succeeded');
    assert.equal(measurement.coverage, 'complete');
    const metrics = measurement.metrics as JsonObject;
    assert.deepEqual((metrics.successRate as JsonObject).value, {
      kind: 'scalar',
      value: 0.5,
    });
    assert.deepEqual((metrics.meanReward as JsonObject).value, {
      kind: 'scalar',
      value: 0.5,
    });
    assert.deepEqual((metrics.rolloutsFailed as JsonObject).value, {
      kind: 'scalar',
      value: 1,
    });
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy Gym records without rollouts_attempted keep their raw rates scalable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-legacy-failures-'));
  const gym = await fakeGym({
    rollouts: 1,
    rolloutsFailed: 1,
    rolloutsAttempted: null,
    rewardMean: 1,
    passRate: 1,
  });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services),
    );
    const metrics = measurements[0]!.metrics as JsonObject;
    assert.deepEqual((metrics.successRate as JsonObject).value, {
      kind: 'scalar',
      value: 0.5,
    });
    assert.deepEqual((metrics.meanReward as JsonObject).value, {
      kind: 'scalar',
      value: 0.5,
    });
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym evaluator turns train items into task-level feedback for the proposer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-items-'));
  const gym = await fakeGym({
    items: [
      {
        task_id: 'task/a',
        rollouts: 1,
        reward_mean: 0,
        pass_rate: 0,
        rollouts_failed: 0,
        checks: [
          {
            id: 'answer-match/0',
            status: 'failed',
            score: 0,
            reason: 'The rollout did not match the expected normalized answer.',
          },
        ],
        diagnostics: [
          {
            kind: 'gym-rollout',
            code: 'extracted_answer',
            message: 'Extracted answer: 17000',
            truncated: false,
          },
        ],
        truncated: false,
      },
      {
        task_id: 'task/b',
        rollouts: 1,
        reward_mean: 1,
        pass_rate: 1,
        rollouts_failed: 0,
        checks: [
          { id: 'answer-match/0', status: 'passed', score: 1, reason: null },
        ],
        diagnostics: [],
        truncated: false,
      },
    ],
  });
  const execution = await bundle(root);
  const { services, measurements, stored } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a', 'task/b'] },
      context(root, services),
    );

    const measurement = measurements[0]!;
    const catalog = stored.get(String(measurement.itemsRef)) as JsonObject;
    const catalogItems = catalog.items as JsonObject[];
    const failed = catalogItems.find((item) => item.id === 'task/a')!;
    assert.notEqual(failed.evaluation, null);
    const evaluation = failed.evaluation as JsonObject;
    const feedback = stored.get(String(evaluation.artifactRef)) as JsonObject;
    validate(evaluationFeedbackSchema, feedback, 'training feedback');
    assert.equal(feedback.passed, false);
    assert.equal((feedback.checks as JsonObject[])[0]!.status, 'failed');
    assert.match(
      String((feedback.checks as JsonObject[])[0]!.reason),
      /expected normalized answer/,
    );

    const projected = await projectEvidence({
      measurements,
      artifacts: services.artifacts,
      view: 'training-summary',
      maxBytes: 64 * 1024,
    });
    const evidence = JSON.stringify(projected);
    assert.match(evidence, /answer-match\/0/);
    assert.match(evidence, /Extracted answer: 17000/);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym evaluator keeps polling while a submitted result is not visible yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-missing-result-'));
  const gym = await fakeGym({ missingResultPolls: 2 });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    const output = await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services),
    );
    assert.deepEqual(output, { measurementRef: 'measurement:1' });
    assert.equal(gym.submitCount(), 1);
    assert.ok(gym.resultCount() >= 3);
    assert.equal(measurements[0]!.status, 'succeeded');
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted Gym results are recorded but rejected as non-comparable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-untrusted-'));
  const gym = await fakeGym({ trusted: false });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        context(root, services),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { status?: string }).status, 'unknown');
        assert.match(error.message, /untrusted/);
        return true;
      },
    );
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]!.status, 'unknown');
    assert.equal(measurements[0]!.comparisonKey, null);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing Gym overfit-guard decision fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-untrusted-missing-'));
  const gym = await fakeGym({ trusted: null });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        context(root, services),
      ),
      /no overfit-guard trust decision/,
    );
    assert.equal(measurements[0]!.status, 'unknown');
    assert.equal(measurements[0]!.comparisonKey, null);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a Gym result for a different candidate digest is not accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-digest-mismatch-'));
  const gym = await fakeGym({
    resultCandidateDigest: `sha256:${'f'.repeat(64)}`,
  });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        context(root, services),
      ),
      /returned candidate digest .* expected/,
    );
    assert.equal(measurements[0]!.status, 'failed');
    assert.equal(measurements[0]!.comparisonKey, null);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('in-band rejected submissions become failed measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-rejected-'));
  const gym = await fakeGym({ status: 'rejected' });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        context(root, services),
      ),
      /fixture rejection/,
    );
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]!.status, 'failed');
    assert.equal(measurements[0]!.comparisonKey, null);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted poll resumes by eval id and reports progress without a second submission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-resume-'));
  const gym = await fakeGym({ queuedResultPolls: 2, rolloutsAttempted: 1 });
  const execution = await bundle(root);
  const { services, measurements, charges } = harness(root, execution);
  const controller = new AbortController();
  const waiting = 'waiting for gym eval-0000000000000001';
  const pending = `${waiting} · queued · 1 rollouts attempted`;
  const records: LogRecord[] = [];
  configureSync({
    sinks: {
      capture(record) {
        records.push(record);
        if (record.properties.detail === pending)
          controller.abort('fixture abort');
      },
    },
    loggers: [
      {
        category: ['arsi', 'plugin', 'gym'],
        lowestLevel: 'debug',
        sinks: ['capture'],
      },
      { category: ['logtape', 'meta'], lowestLevel: null },
    ],
  });
  t.after(resetSync);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    const aborted = context(root, services, 'call-1').extend({
      signal: controller.signal,
    });
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        aborted,
      ),
      /abort|comparable|Gym/i,
    );
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]!.status, 'failed');
    const output = await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services, 'call-2'),
    );
    assert.deepEqual(output, { measurementRef: 'measurement:2' });
    assert.equal(gym.submitCount(), 1);
    assert.deepEqual(charges, ['evaluationRuns']);
    assert.equal(measurements[1]!.status, 'succeeded');
    assert.deepEqual(
      records
        .filter(({ properties }) => properties.progressOnly === true)
        .map(({ properties }) => properties.activeTask),
      [
        { id: 'call-1', detail: 'submitting 1 tasks to gym' },
        { id: 'call-1', detail: waiting },
        { id: 'call-1', detail: `${waiting} · queued` },
        { id: 'call-1', detail: pending },
        { id: 'call-2', detail: waiting },
        { id: 'call-2', detail: pending },
      ],
    );
    assert.deepEqual(
      records
        .filter(({ properties }) => properties.progressOnly !== true)
        .map(({ properties }) => [properties.callId, properties.detail]),
      [
        ['call-1', waiting],
        ['call-2', waiting],
      ],
    );
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a lost Gym submission response records an unknown submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-unknown-submit-'));
  const gym = await fakeGym({ dropSubmitResponseOnce: true });
  const execution = await bundle(root);
  const { services, facts } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    const input = { candidateRef: 'candidate:a', taskIds: ['task/a'] };
    const callContext = context(root, services);
    await assert.rejects(operation.execute(input, callContext));
    assert.equal([...facts.values()][0]!.status, 'unknown');
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym measurement identity includes budget and evaluation digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-identity-'));
  const gym = await fakeGym();
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const first = await createGym(
      { ...config(gym.baseUrl), budget: { maxRollouts: 1 } },
      services,
    );
    await first.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services, 'call-budget-1'),
    );
    const second = await createGym(
      { ...config(gym.baseUrl), budget: { maxRollouts: 2 } },
      services,
    );
    await second.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services, 'call-budget-2'),
    );
    gym.setEvaluationDigest(`sha256:${'e'.repeat(64)}`);
    const third = await createGym(
      { ...config(gym.baseUrl), budget: { maxRollouts: 2 } },
      services,
    );
    await third.execute(
      { candidateRef: 'candidate:b', taskIds: ['task/a'] },
      context(root, services, 'call-digest-2'),
    );

    const keys = measurements.map((measurement) =>
      String(measurement.comparisonKey),
    );
    assert.equal(new Set(keys).size, 3);
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym coverage requires every requested task to attempt a rollout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-coverage-'));
  const gym = await fakeGym({
    rollouts: 2,
    items: [
      {
        task_id: 'task/a',
        rollouts: 2,
        reward_mean: 1,
        pass_rate: 1,
        rollouts_failed: 0,
        checks: [
          { id: 'answer-match/0', status: 'passed', score: 1, reason: null },
        ],
        diagnostics: [],
        truncated: false,
      },
    ],
  });
  const execution = await bundle(root);
  const { services, measurements, stored } = harness(root, execution);
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a', 'task/b'] },
        context(root, services),
      ),
      /coverage is incomplete/i,
    );
    assert.equal(measurements[0]!.coverage, 'partial');
    assert.equal(measurements[0]!.status, 'succeeded');
    const catalog = stored.get(String(measurements[0]!.itemsRef)) as JsonObject;
    const missing = (catalog.items as JsonObject[]).find(
      (item) => item.id === 'task/b',
    )!;
    assert.equal(missing.status, 'unknown');
    assert.equal(missing.coverage, 'none');
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('gym evaluator keeps the result when submission persistence warns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-submit-warning-'));
  const gym = await fakeGym();
  const execution = await bundle(root);
  const { services, measurements, stored } = harness(root, execution, {
    failFactWrites: [2],
  });
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services),
    );
    assert.equal(measurements[0]!.status, 'succeeded');
    const profile = stored.get(
      String((measurements[0]!.profile as JsonObject).artifactRef),
    ) as JsonObject;
    assert.match(
      JSON.stringify(profile.warnings),
      /accepted but not persisted/,
    );
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a prepared submission remains retryable when eval-id persistence fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-submit-recover-'));
  const gym = await fakeGym();
  const execution = await bundle(root);
  const { services, facts } = harness(root, execution, {
    failFactWrites: [2, 3],
  });
  try {
    const operation = await createGym(config(gym.baseUrl), services);
    const input = { candidateRef: 'candidate:a', taskIds: ['task/a'] };
    const callContext = context(root, services);
    await assert.rejects(operation.execute(input, callContext));
    assert.ok([...facts.values()].some((value) => value.status === 'prepared'));
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});
