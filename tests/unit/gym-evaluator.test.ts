import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { RuntimeContext } from '../../src/index.js';
import type { JsonObject, JsonValue } from '../../src/index.js';
import {
  evaluationFeedbackSchema,
  metricDefinitionSchema,
  validateMeasurement,
} from '../../src/contracts/models/measurement.js';
import { projectEvidence } from '../../src/runtime/services/facts/evidence.js';
import { validate } from '../../src/shared/schema.js';
import { activateCandidate } from '../../src/plugins/evaluator-gym/activation.js';
import {
  createGym,
  resolveGymConfig,
} from '../../src/plugins/evaluator-gym/service.js';
import {
  gymConfigSchema,
  type GymConfig,
} from '../../src/plugins/evaluator-gym/schema.js';

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
    activation: {
      kind: 'dsh-user-layer',
      dshHome: '${DSH_HOME}',
      profileName: '${DSH_PROFILE}',
      basePatch: '${RSI_DSH_BASE_PATCH}',
    },
  };
  assert.deepEqual(
    resolveGymConfig(config, {
      GYM_BASE_URL: 'http://127.0.0.1:8399',
      DSH_HOME: '/tmp/dsh',
      DSH_PROFILE: 'headless',
      RSI_DSH_BASE_PATCH: '/tmp/base.patch.yml',
    }),
    {
      ...config,
      baseUrl: 'http://127.0.0.1:8399',
      activation: {
        kind: 'dsh-user-layer',
        dshHome: '/tmp/dsh',
        profileName: 'headless',
        basePatch: '/tmp/base.patch.yml',
      },
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
  artifactDigest: string;
}

interface Harness {
  services: RuntimeContext;
  stored: Map<string, JsonValue>;
  measurements: JsonObject[];
  charges: string[];
}

function harness(root: string, execution: Execution): Harness {
  const stored = new Map<string, JsonValue>();
  const facts = new Map<string, JsonObject>();
  const measurements: JsonObject[] = [];
  const charges: string[] = [];
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
  return { services, stored, measurements, charges };
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
  trusted?: boolean;
  queuedForever?: boolean;
  missingResultPolls?: number;
  items?: JsonValue[];
}

async function fakeGym(options: FakeGymOptions = {}): Promise<{
  baseUrl: string;
  submissions: JsonObject[];
  submitCount: () => number;
  resultCount: () => number;
  setQueuedForever: (value: boolean) => void;
  close: () => Promise<void>;
}> {
  const submissions: JsonObject[] = [];
  let queuedForever = options.queuedForever ?? false;
  const missingResultPolls = options.missingResultPolls ?? 0;
  let resultCount = 0;
  const server = createServer(async (request, response) => {
    const input = await requestBody(request);
    if (request.url === '/gym_evaluate') {
      submissions.push(input);
      const rejected = options.status === 'rejected';
      reply(response, 200, {
        eval_id: `eval-${String(submissions.length).padStart(16, '0')}`,
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
      if (queuedForever) {
        reply(response, 200, {
          found: true,
          result: { eval_id: input.eval_id, status: 'queued' },
        });
        return;
      }
      reply(response, 200, {
        found: true,
        result: {
          eval_id: input.eval_id,
          status: options.status ?? 'completed',
          metrics: {
            reward_mean: options.status === 'failed' ? null : 0.75,
            pass_rate: options.status === 'failed' ? null : 0.5,
            rollouts:
              options.status === 'failed' ? 0 : (options.items?.length ?? 1),
            rollouts_failed: 0,
          },
          overfit_guard: { trusted: options.trusted ?? true },
          experiment_profile_id: 'fixture-profile',
          dataset_version: 'fixture-dataset-v1',
          harness_manifest_digest: MANIFEST_DIGEST,
          environment_digest: ENVIRONMENT_DIGEST,
          evaluation_digest: `sha256:${'d'.repeat(64)}`,
          per_rollout_ref: '/fixture/rollouts.jsonl',
          items: options.items ?? [],
          cost: { total_tokens: 42, wall_time_s: 1.5 },
          warnings: [],
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
    setQueuedForever: (value) => {
      queuedForever = value;
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
    artifactDigest: 'artifact:candidate',
  };
}

function config(baseUrl: string, root: string): GymConfig {
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
    activation: { kind: 'directory', directory: join(root, 'slot') },
  };
}

test('gym evaluator publishes the candidate, submits its digest, and records comparable metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-evaluator-'));
  const gym = await fakeGym();
  const execution = await bundle(root);
  const { services, measurements, stored, charges } = harness(root, execution);
  try {
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
    const output = await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services),
    );
    assert.deepEqual(output, { measurementRef: 'measurement:1' });
    assert.equal(gym.submitCount(), 1);
    assert.equal(gym.submissions[0]!.candidate_digest, BUNDLE_DIGEST);
    assert.deepEqual(gym.submissions[0]!.task_ids, ['task/a']);
    assert.equal(
      await readFile(
        join(root, 'slot', 'plugins', 'fixture', 'instruction.md'),
        'utf8',
      ),
      'v1',
    );
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
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
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
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
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
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
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

test('in-band rejected submissions become failed measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-rejected-'));
  const gym = await fakeGym({ status: 'rejected' });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
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

test('an interrupted poll resumes by eval id without submitting a second rollout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-resume-'));
  const gym = await fakeGym({ queuedForever: true });
  const execution = await bundle(root);
  const { services, measurements } = harness(root, execution);
  try {
    const operation = await createGym(
      config(gym.baseUrl, root),
      services,
      gymConfigSchema,
    );
    const controller = new AbortController();
    const aborted = context(root, services, 'call-1').extend({
      signal: controller.signal,
    });
    setTimeout(() => controller.abort('fixture abort'), 250);
    await assert.rejects(
      operation.execute(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        aborted,
      ),
      /abort|comparable|Gym/i,
    );
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]!.status, 'failed');
    assert.equal(
      await operation.canRetry!(
        { candidateRef: 'candidate:a', taskIds: ['task/a'] },
        { callId: 'call-1', status: 'failed' },
        context(root, services, 'call-1'),
      ),
      true,
    );
    gym.setQueuedForever(false);
    const output = await operation.execute(
      { candidateRef: 'candidate:a', taskIds: ['task/a'] },
      context(root, services, 'call-2'),
    );
    assert.deepEqual(output, { measurementRef: 'measurement:2' });
    assert.equal(gym.submitCount(), 1);
    assert.equal(measurements[1]!.status, 'succeeded');
  } finally {
    await gym.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dsh user-layer activation composes bundle plugin patches and links their packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-dsh-'));
  try {
    const source = join(root, 'bundle');
    const plugin = join(source, 'plugins', 'fixture');
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(source, 'bundle.yaml'),
      'schemaVersion: 1\nname: fixture\nkind: dsh-agent-bundle\nplugins:\n  - path: plugins/fixture\nentry: agent.yaml\nlockfile: dependencies.lock\n',
    );
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({ name: '@fixture/plugin' }),
    );
    await writeFile(
      join(plugin, 'cordis.patch.yml'),
      stringify([{ insert: [{ id: 'fixture', name: '@fixture/plugin' }] }]),
    );
    const dshHome = join(root, 'dsh');
    await mkdir(join(dshHome, 'profiles', 'headless'), { recursive: true });
    const execution = {
      directory: source,
      bundleDigest: BUNDLE_DIGEST,
      artifactDigest: 'a',
    };
    const { services } = harness(root, execution);
    await activateCandidate(
      { kind: 'dsh-user-layer', dshHome },
      context(root, services),
      'candidate:a',
      source,
      BUNDLE_DIGEST,
    );
    const patch = parse(
      await readFile(
        join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
        'utf8',
      ),
    );
    assert.deepEqual(patch, [
      { insert: [{ id: 'fixture', name: '@fixture/plugin' }] },
    ]);
    const entries = await readdir(join(dshHome, 'materialized'));
    assert.equal(entries.length, 1);
    await stat(
      join(
        dshHome,
        'materialized',
        entries[0]!,
        'node_modules',
        '@fixture',
        'plugin',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dsh user-layer activation preserves a host-owned base patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-dsh-base-'));
  try {
    const source = join(root, 'bundle');
    const plugin = join(source, 'plugins', 'fixture');
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(source, 'bundle.yaml'),
      'schemaVersion: 1\nname: fixture\nkind: dsh-agent-bundle\nplugins:\n  - path: plugins/fixture\nentry: agent.yaml\nlockfile: dependencies.lock\n',
    );
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({ name: '@fixture/plugin' }),
    );
    await writeFile(
      join(plugin, 'cordis.patch.yml'),
      stringify([{ insert: [{ id: 'fixture', name: '@fixture/plugin' }] }]),
    );
    const dshHome = join(root, 'dsh');
    const basePatch = join(root, 'base.patch.yml');
    await mkdir(join(dshHome, 'profiles', 'headless'), { recursive: true });
    await writeFile(
      basePatch,
      stringify([
        {
          id: 'host-model',
          config: { provider: 'host-provider', model: 'host-model' },
        },
      ]),
    );
    const execution = {
      directory: source,
      bundleDigest: BUNDLE_DIGEST,
      artifactDigest: 'a',
    };
    const { services } = harness(root, execution);
    await activateCandidate(
      { kind: 'dsh-user-layer', dshHome, basePatch },
      context(root, services),
      'candidate:a',
      source,
      BUNDLE_DIGEST,
    );
    const patch = parse(
      await readFile(
        join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
        'utf8',
      ),
    );
    assert.deepEqual(patch, [
      {
        id: 'host-model',
        config: { provider: 'host-provider', model: 'host-model' },
      },
      { insert: [{ id: 'fixture', name: '@fixture/plugin' }] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote candidate activation must confirm the requested bundle digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gym-remote-activation-'));
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      // The activation request body is not needed for this fixture.
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ready: true,
        candidate_id: 'candidate:a',
        candidate_digest: `sha256:${'f'.repeat(64)}`,
      }),
    );
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind a TCP port');
    const context = new RuntimeContext().extend({
      rootDirectory: root,
      signal: new AbortController().signal,
    });
    await assert.rejects(
      activateCandidate(
        {
          kind: 'remote-http',
          activateUrl: `http://127.0.0.1:${address.port}/activate`,
        },
        context,
        'candidate:a',
        root,
        BUNDLE_DIGEST,
      ),
      /did not confirm the requested candidate digest/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
