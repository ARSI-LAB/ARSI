import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { git, modelEnvironment } from '../../.github/review/process.mjs';
import { withSnapshot } from '../../.github/review/prepare.mjs';
import { greenRules } from '../../.github/review/github.mjs';
import {
  eligible,
  publish,
  skipped,
  sticky,
} from '../../.github/review/publish.mjs';
import { review } from '../../.github/review/review.mjs';

const head = 'a'.repeat(40);
const source = new URL('../../.github/review/', import.meta.url);
const schema = JSON.parse(
  await readFile(new URL('finding.schema.json', source), 'utf8'),
);
const snapshot = {
  head,
  schema,
  prompt: 'trusted',
  context: [],
  anchors: new Map([['diff.ts', { RIGHT: [[1, 2]], LEFT: [] }]]),
  patch: '+example',
  skillLoaded: false,
};
const input = {
  rules: [],
  title: 'Title',
  body: 'Description',
  issues: [],
  threads: [],
};
const finding = {
  severity: 'Important',
  finding_id: 'a',
  bug_class: 'wrong-result',
  file: 'diff.ts',
  line: 1,
  side: 'RIGHT',
  problem: 'bad',
  impact: 'wrong result',
  recommendation: 'fix',
  evidence: 'caller expects a number',
  remediation: 'return a number',
  acceptance: 'unit test',
};
const result = (findings, threads = []) => ({ findings, threads });
const ok = async () => {};
const state = { round: 0, nits: [] };
const pr = { number: 12, head: { sha: head } };

test('review reads trusted assets, strips nested project config and cleans the detached checkout after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arsi-review-test-'));
  try {
    const run = (...args) => git(root, args);
    await run('init', '--template=');
    await run('config', 'user.name', 'Review fixture');
    await run('config', 'user.email', 'fixture@invalid');
    await mkdir(join(root, '.github/review'), { recursive: true });
    for (const [path, text] of [
      ['AGENTS.md', 'Rules'],
      ['.github/review/context-routes.json', '[]'],
      ['.github/review/finding.schema.json', JSON.stringify(schema)],
      ['.github/review/system-prompt.md', 'Trusted review'],
      ['diff.ts', 'one\ntwo\n'],
    ])
      await writeFile(join(root, path), text);
    await run('add', '.');
    await run('-c', 'commit.gpgSign=false', 'commit', '-m', 'base');
    const base = (await run('rev-parse', 'HEAD')).trim();
    await mkdir(join(root, 'folder/.codex'), { recursive: true });
    await writeFile(join(root, 'folder/.codex/config.toml'), '# example');
    await writeFile(
      join(root, '.github/review/system-prompt.md'),
      'Untrusted review',
    );
    await writeFile(join(root, 'diff.ts'), 'one\nnew\n');
    await run('add', '.');
    await run('-c', 'commit.gpgSign=false', 'commit', '-m', 'PR head');
    const sha = (await run('rev-parse', 'HEAD')).trim();
    await run('update-ref', 'refs/pull/12/head', sha);
    const opts = {
      root,
      remote: root,
      trusted: base,
      pr: { number: 12, base: { sha: base }, head: { sha } },
    };
    let checkout;
    await assert.rejects(
      withSnapshot(opts, async (s) => {
        checkout = s.worktree;
        assert.equal(s.prompt, 'Trusted review');
        assert.equal(s.skillLoaded, false);
        assert.equal(existsSync(join(checkout, 'folder/.codex')), false);
        assert.equal(
          await readFile(join(checkout, 'diff.ts'), 'utf8'),
          'one\nnew\n',
        );
        assert.deepEqual(s.anchors.get('diff.ts'), {
          LEFT: [[2, 2]],
          RIGHT: [[2, 2]],
        });
        throw new Error('fixture failure');
      }),
      /fixture failure/,
    );
    assert.equal(existsSync(checkout), false);
    assert.equal(existsSync(join(root, 'folder/.codex/config.toml')), true);
    await writeFile(join(root, 'local.txt'), 'untracked');
    const before = await run('status', '--porcelain');
    await withSnapshot({ root, trusted: base }, async (s) =>
      assert.match(s.patch, /untracked/),
    );
    assert.equal(await run('status', '--porcelain'), before);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('green manifest is scoped to the successful L1 steps; Codex receives only permitted environment variables', () => {
  const job = {
    conclusion: 'success',
    steps: [
      { name: 'Run documentation checks', conclusion: 'success' },
      { name: 'Run full checks', conclusion: 'skipped' },
    ],
  };
  assert.ok(
    greenRules(job).every((rule) => !rule.includes('module boundaries')),
  );
  assert.equal(greenRules({ ...job, conclusion: 'failure' }), null);
  assert.equal(greenRules({ conclusion: 'success', steps: [] }), null);
  const env = modelEnvironment(
    {
      Path: 'tools',
      USERPROFILE: 'profile',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      OTHER_API_KEY: 'secret',
      CODEX_WINDOWS_REGISTERED_CORE: 'true',
      NODE_OPTIONS: 'settings',
    },
    'empty',
  );
  assert.ok(
    Object.values(env).every(
      (value) => !['secret', 'true', 'settings'].includes(value),
    ),
  );
  assert.equal(env.Path, 'tools');
});

test('only Important candidates run a fresh verifier, with strict schema, diff and candidate checks', async () => {
  let calls = 0;
  const noIssues = await review(snapshot, input, undefined, async () => {
    calls++;
    return result([]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(noIssues.findings, []);
  const next = [result([finding]), result([])];
  const dropped = await review(snapshot, input, undefined, async () =>
    next.shift(),
  );
  assert.equal(dropped.dropped, 1);
  await assert.rejects(
    review(snapshot, input, undefined, async () =>
      result([{ ...finding, line: 3 }]),
    ),
    /outside the PR diff/,
  );
  await assert.rejects(
    review(snapshot, input, undefined, async () => ({ findings: [] })),
    /schema/,
  );
  const idSwap = [
    result([finding]),
    result([{ ...finding, finding_id: 'other' }]),
  ];
  await assert.rejects(
    review(snapshot, input, undefined, async () => idSwap.shift()),
    /unsolicited/,
  );
});

test('partial publication reconciles native threads, deduplicates root classes, caps Nits and preserves a single sticky summary', async () => {
  const reviews = [],
    summaries = [];
  const api = {
    review: async (...args) => reviews.push(args),
    summary: async (...args) => summaries.push(args),
  };
  const findings = [
    finding,
    { ...finding, line: 2, finding_id: 'b' },
    ...Array.from({ length: 5 }, (_, i) => ({
      ...finding,
      severity: 'Nit',
      finding_id: 'nit-' + i,
    })),
  ];
  await publish(
    api,
    pr,
    state,
    'worker',
    [],
    snapshot,
    { ...result(findings), dropped: 2 },
    ok,
  );
  assert.equal(reviews[0][2].length, 1);
  assert.match(reviews[0][2][0].body, /Additional occurrences/);
  assert.match(summaries[0][2], /Verifier dropped 2/);
  const owned = { id: 1, body: summaries[0][2], user: { login: 'worker' } };
  const read = sticky(
    [{ ...owned, id: 2, user: { login: 'outsider' } }, owned],
    'worker',
  );
  assert.equal(read.id, 1);
  assert.equal(read.nits.length, 3);
  assert.equal(eligible(read, head), false);
  assert.equal(eligible({ ...read, round: 3 }, 'b'.repeat(40)), false);
  assert.equal(eligible({ ...read, round: 3 }, 'b'.repeat(40), true), true);
  await publish(
    api,
    pr,
    state,
    'worker',
    [{ bug: finding.bug_class, head, resolved: false }],
    snapshot,
    { ...result(findings), dropped: 0 },
    ok,
  );
  assert.equal(reviews.length, 1);
  await skipped(api, pr, state, 'Codex authentication unavailable', ok);
  const skip = sticky([{ ...owned, body: summaries.at(-1)[2] }], 'worker');
  assert.equal(skip.round, 0);
  assert.equal(eligible(skip, head), false);
  assert.equal(eligible(skip, head, true), true);
});

test('only verified owned threads receive replies; a dispute escalates once and a resolved reply survives interruption', async () => {
  const calls = [];
  const api = Object.fromEntries(
    ['summary', 'resolve', 'reply'].map((op) => [
      op,
      async (...args) => calls.push([op, ...args]),
    ]),
  );
  const t = {
    id: 'node1',
    root: { databaseId: 5 },
    head: 'b'.repeat(40),
    resolved: false,
    replies: [{ author: 'contributor', body: 'rationale' }],
  };
  const up = (thread, disposition) =>
    publish(
      api,
      pr,
      state,
      'worker',
      [thread],
      snapshot,
      {
        ...result([], [{ thread_id: t.id, disposition, evidence: 'evidence' }]),
        dropped: 0,
      },
      ok,
    );
  await up(t, 'disagree');
  const reply = calls.find(([op]) => op === 'reply');
  assert.match(reply[3], /\[needs-human\]/);
  assert.equal(
    calls.some(([op]) => op === 'resolve'),
    false,
  );
  await up({ ...t, replies: [{ author: 'worker', body: reply[3] }] }, 'fixed');
  assert.equal(calls.filter(([op]) => op === 'reply').length, 1);
  await up(t, 'fixed');
  const fixed = calls.filter(([op]) => op === 'reply').at(-1)[3];
  await up({ ...t, replies: [{ author: 'worker', body: fixed }] }, 'fixed');
  assert.equal(calls.filter(([op]) => op === 'reply').length, 2);
  assert.equal(calls.filter(([op]) => op === 'resolve').length, 2);
});
