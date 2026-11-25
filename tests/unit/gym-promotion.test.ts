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
import { configureSync, resetSync, type LogRecord } from '@logtape/logtape';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { createGymPromotion } from '../../src/plugins/evaluator-gym/promotion/service.js';
import {
  promotionConfigSchema,
  type GymPromotionConfig,
} from '../../src/plugins/evaluator-gym/promotion/schema.js';
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
  runningBeforeComplete?: boolean;
  failureDigest?: string;
  candidateEnvironment?: string;
  rollouts?: number;
  candidateRollouts?: number;
  incumbentRollouts?: number;
  rolloutsFailed?: number;
  candidateRolloutsFailed?: number;
  incumbentRolloutsFailed?: number;
  candidateRolloutsAttempted?: number | null;
  incumbentRolloutsAttempted?: number | null;
  conflictOnce?: boolean;
  candidateSubmitStatus?: number;
  dropCandidateResponseOnce?: boolean;
  candidatePassRate?: number | null;
  incumbentPassRate?: number | null;
  candidateWarnings?: string[];
  incumbentWarnings?: string[];
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
  const running = new Set<string>();
  const completedReports = new Map<string, JsonObject>();
  let counter = 0;
  let conflictIssued = false;
  let dropCandidateResponse = options.dropCandidateResponseOnce ?? false;
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === 'POST' && request.url === '/promotion') {
        const body = object(await jsonBody(request));
        const digest = string(body.candidate_digest);
        if (digest === CANDIDATE_DIGEST && dropCandidateResponse) {
          dropCandidateResponse = false;
          const id = `promo-${String(++counter).padStart(16, '0')}`;
          jobs.set(id, { body, id });
          response.destroy();
          return;
        }
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
        if (options.runningBeforeComplete && !running.has(job.id)) {
          running.add(job.id);
          json(response, 200, { promotion_id: job.id, state: 'running' });
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
  const successful =
    digest === CANDIDATE_DIGEST
      ? (options.candidateRollouts ?? options.rollouts ?? 4)
      : (options.incumbentRollouts ?? options.rollouts ?? 4);
  const failed =
    digest === CANDIDATE_DIGEST
      ? (options.candidateRolloutsFailed ?? options.rolloutsFailed ?? 0)
      : (options.incumbentRolloutsFailed ?? options.rolloutsFailed ?? 0);
  const attempted =
    digest === CANDIDATE_DIGEST
      ? options.candidateRolloutsAttempted
      : options.incumbentRolloutsAttempted;
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
      rollouts: successful,
      rollouts_failed: failed,
      ...(attempted === null
        ? {}
        : { rollouts_attempted: attempted ?? successful + failed }),
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
    warnings:
      digest === CANDIDATE_DIGEST
        ? (options.candidateWarnings ?? [])
        : (options.incumbentWarnings ?? []),
    generated_at: new Date().toISOString(),
  };
}

function harness(): {
  context: RuntimeContext;
  artifacts: Map<string, JsonObject>;
  charges: string[];
  instances: { ref: string }[];
} {
  const artifacts = new Map<string, JsonObject>();
  const charges: string[] = [];
  const instances: { ref: string }[] = [];
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
      read: async () => {
        throw new Error('unused');
      },
      write: async () => {},
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
    ): Promise<T> => {
      assert.equal(capability, 'agentbundle');
      instances.push({ ref });
      const directory = await mkdtemp(join(tmpdir(), 'release-bundle-'));
      return use({
        directory,
        bundleDigest: digestFor(ref),
        bundleKind: 'dsh-agent-bundle',
      });
    },
  });
  return { context, artifacts, charges, instances };
}

function config(baseUrl: string): GymPromotionConfig {
  return {
    baseUrl,
    promotionDefaults: {
      adapter: 'dsh_candidate',
      benchmark: 'gaia_text_validation',
      seed: 43,
    },
    poll: { intervalMs: 100, timeoutMs: 5000 },
  };
}

function withSeed(value: GymPromotionConfig, seed: number): GymPromotionConfig {
  return {
    ...value,
    promotionDefaults: { ...value.promotionDefaults, seed },
  };
}

test('gym promotion compares both holdouts and reports each pending state', async (t) => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { runningBeforeComplete: true },
  );
  const records: LogRecord[] = [];
  configureSync({
    sinks: {
      capture: (record) => {
        records.push(record);
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
    const { context, artifacts, charges, instances } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
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
        'candidate_dir',
        'candidate_id',
        'candidate_kind',
        'seed',
        'tier',
      ]);
      assert.equal(entry.body.tier, 'full');
      assert.equal(Object.hasOwn(entry.body, 'split'), false);
      assert.equal(Object.hasOwn(entry.body, 'task_ids'), false);
    }
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
    assert.deepEqual(instances, [
      { ref: 'candidate:final' },
      { ref: 'candidate:incumbent' },
    ]);
    const roles = ['candidate', 'incumbent'];
    const waiting = gym.posted.map(
      ({ id }, index) => `waiting for gym ${roles[index]} promotion ${id}`,
    );
    assert.deepEqual(
      records
        .filter(({ properties }) => properties.progressOnly === true)
        .map(({ properties }) => properties.activeTask),
      waiting.flatMap((detail, index) =>
        [
          `submitting ${roles[index]} holdout to gym`,
          detail,
          `${detail} · queued`,
          `${detail} · running`,
        ].map((text) => ({ id: context.callId, detail: text })),
      ),
    );
    assert.deepEqual(
      records
        .filter(({ properties }) => properties.progressOnly !== true)
        .map(({ properties }) => properties.detail),
      waiting,
    );
    const record = artifacts.get(output.promotionRef)!;
    assert.equal(record.decision, 'promote');
    assert.ok(Math.abs(Number(object(record.comparison).delta) - 0.3) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('gym promotion carries each candidate directory and kind to every promotion', async () => {
  const gym = await gymFixture({
    [CANDIDATE_DIGEST]: 0.8,
    [INCUMBENT_DIGEST]: 0.5,
  });
  try {
    const { context, instances } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
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
      assert.equal(typeof entry.body.candidate_dir, 'string');
      assert.equal(entry.body.candidate_kind, 'dsh-agent-bundle');
      assert.equal(Object.hasOwn(entry.body, 'split'), false);
      assert.equal(Object.hasOwn(entry.body, 'task_ids'), false);
    }
    assert.deepEqual(instances, [
      { ref: 'candidate:final' },
      { ref: 'candidate:incumbent' },
    ]);
  } finally {
    await gym.close();
  }
});

test('gym promotion skips holdout when the candidate did not advance', async () => {
  const gym = await gymFixture({ [CANDIDATE_DIGEST]: 1 });
  try {
    const { context, artifacts, charges, instances } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:final' },
      context,
    );
    assert.equal(output.decision, 'keep-incumbent');
    assert.match(output.reason, /did not advance beyond validation/);
    assert.equal(gym.posted.length, 0);
    assert.deepEqual(charges, []);
    assert.deepEqual(instances, []);
    const record = artifacts.get(output.promotionRef)!;
    assert.equal(record.decision, 'keep-incumbent');
    assert.equal(record.holdoutSkipped, true);
    assert.equal(record.comparison, null);
    assert.equal(object(record.candidate).promotionState, 'skipped');
  } finally {
    await gym.close();
  }
});

test('gym promotion keeps the incumbent on a tie and rejects environment drift', async () => {
  const tie = await gymFixture({
    [CANDIDATE_DIGEST]: 0.7,
    [INCUMBENT_DIGEST]: 0.7,
  });
  try {
    const { context } = harness();
    const release = await createGymPromotion(config(tie.baseUrl), context);
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
    const release = await createGymPromotion(config(drift.baseUrl), context);
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

test('gym promotion rejects a failed candidate without spending an incumbent holdout', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { failureDigest: CANDIDATE_DIGEST },
  );
  try {
    const { context, charges } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
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

test('gym promotion rejects incomplete report metrics before comparing candidates', async () => {
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
      const release = await createGymPromotion(config(gym.baseUrl), context);
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

test('gym promotion does not scale current Gym rates twice when rollouts fail', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { rollouts: 4, candidateRolloutsFailed: 1, candidatePassRate: 0.8 },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    assert.equal(gym.posted.length, 2);
    const comparison = object(artifacts.get(output.promotionRef)!.comparison);
    assert.equal(comparison.metric, 'successRate');
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.8) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
    assert.ok(Math.abs(Number(comparison.delta) - 0.3) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('gym promotion scales legacy pass rates that omit rollouts_attempted', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    {
      candidateRollouts: 3,
      candidateRolloutsFailed: 1,
      candidateRolloutsAttempted: null,
      candidatePassRate: 1,
      incumbentRollouts: 4,
      incumbentPassRate: 0.5,
    },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    const comparison = object(artifacts.get(output.promotionRef)!.comparison);
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.75) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('gym promotion compares reports reused across a seed change', async () => {
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
    const first = await createGymPromotion(
      withSeed(config(gym.baseUrl), 43),
      context,
    );
    await first.execute(input, context);
    const second = await createGymPromotion(
      withSeed(config(gym.baseUrl), 44),
      context,
    );
    const output = await second.execute(input, context);
    assert.equal(output.decision, 'promote');
    assert.equal(gym.posted.length, 2);
    assert.deepEqual(charges, ['evaluationRuns', 'evaluationRuns']);
  } finally {
    await gym.close();
  }
});

test('gym promotion attaches to an existing promotion on HTTP 409', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { conflictOnce: true },
  );
  try {
    const { context } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
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

test('gym promotion rejects Gym trust warnings before spending an incumbent holdout', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    {
      candidateWarnings: [
        'split_eval_soft_limit_exceeded; results marked trusted=false (OF-4)',
      ],
    },
  );
  try {
    const { context, charges } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'reject');
    assert.match(output.reason, /trust warning/);
    assert.equal(gym.posted.length, 1);
    assert.deepEqual(charges, ['evaluationRuns']);
  } finally {
    await gym.close();
  }
});

test('gym promotion rejects a permanent HTTP failure', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidateSubmitStatus: 400 },
  );
  try {
    const { context } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
    const input = {
      candidateRef: 'candidate:final',
      incumbentRef: 'candidate:incumbent',
    };
    await assert.rejects(release.execute(input, context), /HTTP 400/);
  } finally {
    await gym.close();
  }
});

test('gym promotion does not charge again when Gym reuses completed reports', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { reuseCompletedReports: true },
  );
  try {
    const { context, charges } = harness();
    const release = await createGymPromotion(config(gym.baseUrl), context);
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

test('gym promotion can compare dense mean reward independently of pass rate', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidatePassRate: 0.5, incumbentPassRate: 0.5 },
  );
  try {
    const { context, artifacts } = harness();
    const release = await createGymPromotion(
      { ...config(gym.baseUrl), metric: 'meanReward' },
      context,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
    const comparison = object(artifacts.get(output.promotionRef)!.comparison);
    assert.equal(comparison.metric, 'meanReward');
    assert.ok(Math.abs(Number(comparison.candidateValue) - 0.8) < 1e-12);
    assert.ok(Math.abs(Number(comparison.incumbentValue) - 0.5) < 1e-12);
  } finally {
    await gym.close();
  }
});

test('gym promotion does not require the unselected Gym metric', async () => {
  const gym = await gymFixture(
    { [CANDIDATE_DIGEST]: 0.8, [INCUMBENT_DIGEST]: 0.5 },
    { candidatePassRate: null, incumbentPassRate: null },
  );
  try {
    const { context } = harness();
    const release = await createGymPromotion(
      { ...config(gym.baseUrl), metric: 'meanReward' },
      context,
    );
    const output = await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(output.decision, 'promote');
  } finally {
    await gym.close();
  }
});

test('promotion config cannot express split or task ids', () => {
  assert.throws(
    () =>
      validate(
        promotionConfigSchema,
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
        'promotion config',
      ),
    /additional properties/,
  );
});

test('promotion config rejects max_rollouts because holdout is always complete', () => {
  assert.throws(
    () =>
      validate(
        promotionConfigSchema,
        {
          baseUrl: 'http://127.0.0.1:8399',
          promotionDefaults: {
            adapter: 'dsh_candidate',
            benchmark: 'gaia_text_validation',
            seed: 43,
            budget: { maxRollouts: 1 },
          },
        },
        'promotion config',
      ),
    /additional properties/,
  );
});

test('gym promotion sends only the promotion timeout budget', async () => {
  const gym = await gymFixture({
    [CANDIDATE_DIGEST]: 0.8,
    [INCUMBENT_DIGEST]: 0.5,
  });
  try {
    const { context } = harness();
    const settings = config(gym.baseUrl);
    const release = await createGymPromotion(
      {
        ...settings,
        promotionDefaults: {
          ...settings.promotionDefaults,
          budget: { timeoutS: 60 },
        },
      },
      context,
    );
    await release.execute(
      { candidateRef: 'candidate:final', incumbentRef: 'candidate:incumbent' },
      context,
    );
    assert.equal(gym.posted.length, 2);
    for (const entry of gym.posted)
      assert.deepEqual(entry.body.budget, { timeout_s: 60 });
  } finally {
    await gym.close();
  }
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
