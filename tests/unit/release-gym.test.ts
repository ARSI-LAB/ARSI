import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeContext, type JsonObject } from '../../src/index.js';
import { createGymRelease } from '../../src/plugins/release-gym/service.js';
import {
  releaseConfigSchema,
  type GymReleaseConfig,
} from '../../src/plugins/release-gym/schema.js';
import { validate } from '../../src/shared/schema.js';

const CANDIDATE_DIGEST = `sha256:${'c'.repeat(64)}`;
const INCUMBENT_DIGEST = `sha256:${'d'.repeat(64)}`;
const HARNESS_DIGEST = `sha256:${'a'.repeat(64)}`;
const ENVIRONMENT_DIGEST = `sha256:${'b'.repeat(64)}`;
const EVALUATION_DIGEST = `sha256:${'e'.repeat(64)}`;

interface PostedPromotion {
  body: JsonObject;
  id: string;
}

interface GymFixture {
  baseUrl: string;
  posted: PostedPromotion[];
  close(): Promise<void>;
}

interface FixtureOptions {
  failureDigest?: string;
  candidateEnvironment?: string;
  rollouts?: number;
  candidateRollouts?: number;
  incumbentRollouts?: number;
  rolloutsFailed?: number;
  candidateRolloutsFailed?: number;
  incumbentRolloutsFailed?: number;
  conflictOnce?: boolean;
  candidateSubmitStatus?: number;
  candidatePassRate?: number;
  incumbentPassRate?: number;
  reuseCompletedReports?: boolean;
}

function digestFor(ref: string): string {
  return ref === 'candidate:final' ? CANDIDATE_DIGEST : INCUMBENT_DIGEST;
}

async function gymFixture(
  rewards: Readonly<Record<string, number>>,
  options: FixtureOptions = {},
): Promise<GymFixture> {
  const posted: PostedPromotion[] = [];
  const jobs = new Map<string, PostedPromotion>();
  const completedReports = new Map<string, JsonObject>();
  let counter = 0;
  let conflictIssued = false;
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === 'POST' && request.url === '/promotion') {
        const body = object(await jsonBody(request));
        const digest = string(body.candidate_digest);
        const completed = completedReports.get(digest);
        if (options.reuseCompletedReports && completed !== undefined) {
          json(response, 200, {
            promotion_id: completed.promotion_id,
            state: 'completed',
            candidate_id: body.candidate_id,
            candidate_digest: digest,
            benchmark: body.benchmark,
            reused: true,
            report: completed,
          });
          return;
        }
        if (
          digest === CANDIDATE_DIGEST &&
          options.candidateSubmitStatus !== undefined
        ) {
          json(response, options.candidateSubmitStatus, {
            detail: 'fixture candidate submission failure',
          });
          return;
        }
        const id = `promo-${String(++counter).padStart(16, '0')}`;
        const postedValue = { body, id };
        if (options.conflictOnce && !conflictIssued) {
          conflictIssued = true;
          jobs.set(id, postedValue);
          json(response, 409, {
            detail: {
              promotion_id: id,
              message: 'promotion already running',
              fix_hint: 'poll the existing promotion',
            },
          });
          return;
        }
        posted.push(postedValue);
        jobs.set(id, postedValue);
        json(response, 202, {
          promotion_id: id,
          state: 'queued',
          candidate_id: body.candidate_id,
          candidate_digest: body.candidate_digest,
          benchmark: body.benchmark,
        });
        return;
      }
      const match = /^\/promotion\/(promo-[0-9a-f]{16})$/.exec(
        request.url ?? '',
      );
      if (request.method === 'GET' && match) {
        const job = jobs.get(match[1]!);
        if (!job) {
          json(response, 404, { detail: 'promotion not found' });
          return;
        }
        const digest = string(job.body.candidate_digest);
        if (options.failureDigest === digest) {
          json(response, 200, {
            promotion_id: job.id,
            state: 'failed',
            report: null,
            error: { code: 'EVAL_FAILED', message: 'holdout rollout failed' },
          });
          return;
        }
        const report = reportFor(job, rewards[digest] ?? 0, options);
        completedReports.set(digest, report);
        json(response, 200, {
          promotion_id: job.id,
          state: 'completed',
          report,
        });
        return;
      }
      json(response, 404, { detail: 'not found' });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    posted,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function reportFor(
  job: PostedPromotion,
  reward: number,
  options: FixtureOptions,
): JsonObject {
  const digest = string(job.body.candidate_digest);
  return {
    promotion_id: job.id,
    eval_id: `eval-${digest.slice(-8)}`,
    candidate_id: job.body.candidate_id,
    candidate_digest: digest,
    adapter: job.body.adapter,
    benchmark: job.body.benchmark,
    split: 'holdout',
    tier: 'full',
    seed: job.body.seed,
    status: 'completed',
    metrics: {
      reward_mean: reward,
      pass_rate:
        digest === CANDIDATE_DIGEST
          ? (options.candidatePassRate ?? reward)
          : (options.incumbentPassRate ?? reward),
      rollouts:
        digest === CANDIDATE_DIGEST
          ? (options.candidateRollouts ?? options.rollouts ?? 4)
          : (options.incumbentRollouts ?? options.rollouts ?? 4),
      rollouts_failed:
        digest === CANDIDATE_DIGEST
          ? (options.candidateRolloutsFailed ?? options.rolloutsFailed ?? 0)
          : (options.incumbentRolloutsFailed ?? options.rolloutsFailed ?? 0),
    },
    manifest_schema_version: 2,
    harness_manifest_digest: HARNESS_DIGEST,
    environment_digest:
      digest === CANDIDATE_DIGEST
        ? (options.candidateEnvironment ?? ENVIRONMENT_DIGEST)
        : ENVIRONMENT_DIGEST,
    evaluation_digest: EVALUATION_DIGEST,
    experiment_profile_id: 'gaia',
    dataset_version: 'gaia-v1',
    generated_at: new Date().toISOString(),
  };
}

function harness(): {
  context: RuntimeContext;
  artifacts: Map<string, JsonObject>;
  charges: string[];
  instances: Array<{ ref: string; instanceKey?: string }>;
  facts: Map<string, JsonObject>;
} {
  const artifacts = new Map<string, JsonObject>();
  const facts = new Map<string, JsonObject>();
  const charges: string[] = [];
  const instances: Array<{ ref: string; instanceKey?: string }> = [];
  const context = new RuntimeContext().extend({
    experimentId: 'experiment',
    callId: 'release',
    bindingId: 'release',
    idempotencyKey: 'release',
    directory: tmpdir(),
    rootDirectory: tmpdir(),
    dataDirectory: tmpdir(),
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
    artifacts: {
      putJson: async (value: unknown) => {
        const ref = `artifact:${artifacts.size}`;
        artifacts.set(ref, structuredClone(value) as JsonObject);
        return ref;
      },
      readJson: async (ref: string) => artifacts.get(ref)!,
      capture: async () => 'artifact:tree',
      materialize: async () => {},
    },
    facts: {
      read: async (kind: string, id: string) => {
        const value = facts.get(`${kind}/${id}`);
        if (value === undefined)
          throw Object.assign(new Error('missing fact'), { code: 'ENOENT' });
        return structuredClone(value);
      },
      write: async (kind: string, id: string, value: JsonObject) => {
        facts.set(`${kind}/${id}`, structuredClone(value));
      },
      list: async () => [],
    },
    workspaces: {
      create: async () => ({
        ref: 'ws',
        directory: tmpdir(),
        parentCandidateRef: null,
      }),
      read: async () => ({
        ref: 'ws',
        directory: tmpdir(),
        parentCandidateRef: null,
      }),
      release: async () => {},
    },
    readCandidate: async () => {
      throw new Error('unused');
    },
    recordCandidate: async () => {
      throw new Error('unused');
    },
    recordMeasurement: async () => {
      throw new Error('unused');
    },
    readMeasurement: async () => {
      throw new Error('unused');
    },
    application: async () => {
      throw new Error('unused');
    },
    applicationMetadata: async () => {
      throw new Error('unused');
    },
    invoke: async () => {
      throw new Error('unused');
    },
    invokeAgent: async () => {
      throw new Error('unused');
    },
    readEvidence: async () => [],
    charge: async (metric: string) => {
      charges.push(metric);
    },
    withInstance: async <T>(
      ref: string,
      capability: string,
      use: (execution: JsonObject) => Promise<T>,
      options?: { instanceKey?: string },
    ): Promise<T> => {
      assert.equal(capability, 'agentbundle');
      instances.push({
        ref,
        ...(options?.instanceKey === undefined
          ? {}
          : { instanceKey: options.instanceKey }),
      });
      const directory = await mkdtemp(join(tmpdir(), 'release-bundle-'));
      return use({
        directory,
        bundleDigest: digestFor(ref),
      });
    },
  });
  return { context, artifacts, charges, instances, facts };
}

function config(
  baseUrl: string,
  activation?: GymReleaseConfig['activation'],
): GymReleaseConfig {
  return {
    baseUrl,
    promotionDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      seed: 43,
    },
    poll: { intervalMs: 100, timeoutMs: 5000 },
    ...(activation === undefined ? {} : { activation }),
  };
}

function withSeed(value: GymReleaseConfig, seed: number): GymReleaseConfig {
  return {
    ...value,
    promotionDefaults: { ...value.promotionDefaults, seed },
  };
}

test('release.gym compares candidate and incumbent holdout reports without task pinning', async () => {
  const gym = await gymFixture({
    [CANDIDATE_DIGEST]: 0.8,
    [INCUMBENT_DIGEST]: 0.5,
  });
  try {
    const { context, artifacts, charges, instances } = harness();
    const activation = {
      kind: 'directory' as const,
      directory: await mkdtemp(join(tmpdir(), 'release-target-')),
    };
    const release = await createGymRelease(
      config(gym.baseUrl, activation),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    assert.deepEqual(
      gym.posted.map((entry) => entry.body.candidate_id),
      ['candidate:final', 'candidate:incumbent'],
    );
    for (const entry of gym.posted) {
      assert.deepEqual(Object.keys(entry.body).sort(), [
        'adapter',
        'benchmark',
        'candidate_digest',
        'candidate_id',
        'seed',
        'tier',
      ]);
      assert.equal(entry.body.tier, 'full');
      assert.equal(Object.hasOwn(entry.body, 'split'), false);
      assert.equal(Object.hasOwn(entry.body, 'task_ids'), false);
    }
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
    assert.deepEqual(instances, [
      { ref: 'candidate:final', instanceKey: 'candidate' },
      { ref: 'candidate:incumbent', instanceKey: 'incumbent' },
      { ref: 'candidate:final', instanceKey: 'activate' },
    ]);
    assert.equal(
      await release.canRetry!(
        {
          candidateRef: 'candidate:final',
          incumbentRef: 'candidate:incumbent',
        },
        { callId: 'release', status: 'failed' },
        context,
      ),
      false,
    );
    const record = artifacts.get(output.releaseRef)!;
    assert.equal(record.decision, 'promote');
    assert.ok(Math.abs(Number(object(record.comparison).delta) - 0.3) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('release.gym reuses the candidate report when the incumbent is the same bundle', async () => {
  const gym = await gymFixture({ [CANDIDATE_DIGEST]: 1 });
  try {
    const { context, artifacts, charges, instances } = harness();
    const activation = {
      kind: 'directory' as const,
      directory: await mkdtemp(join(tmpdir(), 'release-target-')),
    };
    const release = await createGymRelease(
      config(gym.baseUrl, activation),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:final' },
      context,
    );
    assert.equal(output.decision, 'keep-incumbent');
    assert.equal(gym.posted.length, 1);
    assert.deepEqual(charges, ['evaluationRuns']);
    assert.deepEqual(instances, [
      { ref: 'candidate:final', instanceKey: 'candidate' },
      { ref: 'candidate:final', instanceKey: 'activate' },
    ]);
    const record = artifacts.get(output.releaseRef)!;
    assert.equal(record.decision, 'keep-incumbent');
    assert.equal(object(record.comparison).delta, 0);
  } finally {
    await gym.close();
  }
});

test('release.gym keeps the incumbent on a tie and rejects environment drift', async () => {
  const tie = await gymFixture({
    [CANDIDATE_DIGEST]: 0.7,
    [INCUMBENT_DIGEST]: 0.7,
  });
  try {
    const { context } = harness();
    const release = await createGymRelease(
      config(tie.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'keep-incumbent');
  } finally {
    await tie.close();
  }

  const drift = await gymFixture(
    {
      [CANDIDATE_DIGEST]: 0.9,
      [INCUMBENT_DIGEST]: 0.5,
    },
    { candidateEnvironment: `sha256:${'f'.repeat(64)}` },
  );
  try {
    const { context } = harness();
    const release = await createGymRelease(
      config(drift.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'reject');
    assert.match(output.reason, /environment_digest differ/);
  } finally {
    await drift.close();
  }
});

test('release.gym rejects a failed candidate without spending an incumbent holdout', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { failureDigest: CANDIDATE_DIGEST },
  );
  try {
    const { context, charges } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'reject');
    assert.equal(gym.posted.length, 1);
    assert.deepEqual(charges, ['evaluationRuns']);
  } finally {
    await gym.close();
  }
});

test('release.gym rejects incomplete report metrics before comparing candidates', async () => {
  const cases: Array<{ options: FixtureOptions; pattern: RegExp }> = [
    { options: { rollouts: 0 }, pattern: /no attempted rollouts/ },
  ];
  for (const scenario of cases) {
    const gym = await gymFixture(
      { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
      scenario.options,
    );
    try {
      const { context } = harness();
      const release = await createGymRelease(
        config(gym.baseUrl),
        context,
        releaseConfigSchema,
      );
      const output = await release.execute(
        {
          candidateRef: 'candidate:final',
          incumbentRef: 'candidate:incumbent',
        },
        context,
      );
      assert.equal(output.decision, 'reject');
      assert.match(output.reason, scenario.pattern);
      assert.equal(gym.posted.length, 1);
    } finally {
      await gym.close();
    }
  }
});

test('release.gym compares effective pass rate when infrastructure rollouts fail', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { rollouts: 4, candidateRolloutsFailed: 1 },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    assert.equal(gym.posted.length, 2);
    const comparison = object(artifacts.get(output.releaseRef)!.comparison);
    assert.equal(comparison.metric, 'successRate');
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.64) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
    assert.ok(Math.abs(Number(comparison.delta) - 0.14) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('release.gym compares effective pass rate when successful rollout counts differ', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    {
      candidateRollouts: 3,
      candidateRolloutsFailed: 1,
      candidatePassRate: 1,
      incumbentRollouts: 4,
      incumbentPassRate: 0.5,
    },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    const comparison = object(artifacts.get(output.releaseRef)!.comparison);
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.75) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('release.gym compares reports reused across a seed change', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { reuseCompletedReports: true },
  );
  try {
    const { context, charges } = harness();
    const input = {
      candidateRef: 'candidate:final',
      incumbentRef: 'candidate:incumbent',
    };
    const first = await createGymRelease(
      withSeed(config(gym.baseUrl), 43),
      context,
      releaseConfigSchema,
    );
    await first.execute(input, context);
    const second = await createGymRelease(
      withSeed(config(gym.baseUrl), 44),
      context,
      releaseConfigSchema,
    );
    const output = await second.execute(input, context);
    assert.equal(output.decision, 'promote');
    assert.equal(gym.posted.length, 2);
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
  } finally {
    await gym.close();
  }
});

test('release.gym attaches to an existing promotion on HTTP 409', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { conflictOnce: true },
  );
  try {
    const { context } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    assert.deepEqual(
      gym.posted.map((entry) => entry.body.candidate_id),
      ['candidate:incumbent'],
    );
  } finally {
    await gym.close();
  }
});

test('release.gym restores the incumbent when candidate promotion fails', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidateSubmitStatus: 500 },
  );
  try {
    const { context, facts, charges, instances } = harness();
    const activation = {
      kind: 'directory' as const,
      directory: await mkdtemp(join(tmpdir(), 'release-target-')),
    };
    const release = await createGymRelease(
      config(gym.baseUrl, activation),
      context,
      releaseConfigSchema,
    );
    const input = {
      candidateRef: 'candidate:final',
      incumbentRef: 'candidate:incumbent',
    };
    await assert.rejects(release.execute(input, context), /HTTP 500/);
    assert.deepEqual(instances, [
      { ref: 'candidate:final', instanceKey: 'candidate' },
      { ref: 'candidate:incumbent', instanceKey: 'activate' },
    ]);
    assert.deepEqual(charges, []);
    const attempt = [...facts.values()][0]!;
    assert.equal(attempt.retryable, true);
    assert.equal(
      await release.canRetry!(
        input,
        { callId: 'release', status: 'failed' },
        context,
      ),
      true,
    );
  } finally {
    await gym.close();
  }
});

test('release.gym does not retry a permanent HTTP failure', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidateSubmitStatus: 400 },
  );
  try {
    const { context } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const input = {
      candidateRef: 'candidate:final',
      incumbentRef: 'candidate:incumbent',
    };
    await assert.rejects(release.execute(input, context), /HTTP 400/);
    assert.equal(
      await release.canRetry!(
        input,
        { callId: 'release', status: 'failed' },
        context,
      ),
      false,
    );
  } finally {
    await gym.close();
  }
});

test('release.gym does not charge again when Gym reuses completed reports', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { reuseCompletedReports: true },
  );
  try {
    const { context, charges } = harness();
    const release = await createGymRelease(
      config(gym.baseUrl),
      context,
      releaseConfigSchema,
    );
    const input = {
      candidateRef: 'candidate:final',
      incumbentRef: 'candidate:incumbent',
    };
    await release.execute(input, context);
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
    const second = await release.execute(input, context);
    assert.equal(second.decision, 'promote');
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
    assert.equal(gym.posted.length, 2);
  } finally {
    await gym.close();
  }
});

test('release.gym can compare dense mean reward independently of pass rate', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidatePassRate: 0.5, incumbentPassRate: 0.5 },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymRelease(
      { ...config(gym.baseUrl), metric: 'meanReward' },
      context,
      releaseConfigSchema,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    const comparison = object(artifacts.get(output.releaseRef)!.comparison);
    assert.equal(comparison.metric, 'meanReward');
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.8) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('release config cannot express split or task ids', () => {
  assert.throws(
    () =>
      validate(
        releaseConfigSchema,
        {
          baseUrl: 'http://127.0.0.1:8399',
          promotionDefaults: {
            adapter: 'dsh_candidate',
            benchmark: 'gaia_text_validation',
            seed: 43,
            split: 'holdout',
            taskIds: ['hidden'],
          },
        },
        'release config',
      ),
    /additional properties/,
  );
});

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected object');
  return value as JsonObject;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('expected string');
  return value;
}
