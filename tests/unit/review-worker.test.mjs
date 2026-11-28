import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  command,
  git,
  modelEnvironment,
} from '../../.github/review/process.mjs';
import { changedLines, withSnapshot } from '../../.github/review/prepare.mjs';
import {
  confirmedRules,
  github,
  greenRules,
} from '../../.github/review/github.mjs';
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

test('fork opt-in requires a maintainer, and L1 belongs to this PR, head and latest attempt', async () => {
  const fork = {
    ...pr,
    author_association: 'CONTRIBUTOR',
    labels: [],
    base: { ref: 'master' },
    head: { sha: head, ref: 'fix', repo: { id: 14 } },
  };
  const run = {
    head_sha: head,
    head_repository: { id: 14 },
    head_branch: 'fix',
    event: 'pull_request',
    pull_requests: [],
    display_title: 'L1 PR #12 ' + head,
    id: 17,
    run_attempt: 2,
  };
  let runs = [run];
  let permission = 'read';
  const api = github('owner/repo', undefined, async (_file, args) => {
    const path = args.find((arg) => arg.startsWith('repos/'));
    if (path.endsWith('/permission')) return JSON.stringify({ permission });
    if (path.includes('/events'))
      return JSON.stringify([
        [
          {
            event: 'labeled',
            label: { name: 'ai-review' },
            actor: { login: 'maintainer' },
          },
        ],
      ]);
    if (path.includes('/workflows/ci.yml/'))
      return JSON.stringify([{ workflow_runs: runs }]);
    if (path.includes('/runs/17/attempts/2/jobs'))
      return JSON.stringify([
        {
          jobs: [
            {
              name: 'CI / Check (Linux)',
              conclusion: 'success',
              steps: [{ name: 'Run full checks', conclusion: 'success' }],
            },
          ],
        },
      ]);
    throw new Error('Unexpected GitHub path ' + path);
  });
  const opt = {
    body: '/ai-review',
    user: { login: 'maintainer' },
    author_association: 'MEMBER',
  };
  assert.equal(
    await api.authorized(fork, [{ ...opt, author_association: 'NONE' }]),
    false,
  );
  assert.equal(await api.authorized(fork, [opt]), false);
  assert.equal(
    await api.authorized({ ...fork, labels: [{ name: 'ai-review' }] }, []),
    false,
  );
  permission = 'write';
  assert.equal(await api.authorized(fork, [opt]), true);
  assert.equal(
    await api.authorized({ ...fork, labels: [{ name: 'ai-review' }] }, []),
    true,
  );
  assert.ok((await api.l1(fork)).includes('TypeScript typechecking'));
  runs = [
    { ...run, display_title: 'L1 PR #11 ' + head },
    { ...run, head_sha: 'b'.repeat(40) },
    { ...run, head_repository: { id: 99 } },
  ];
  assert.equal(await api.l1(fork), null);
});

test('cancellation stops a launcher and its child before snapshot cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arsi-review-abort-'));
  const controller = new AbortController();
  const callback =
    "const fs=require('node:fs'); fs.writeFileSync('ready',''); setTimeout(()=>fs.writeFileSync('late',''),1200)";
  const launch =
    "require('node:child_process').spawn(process.execPath,['-e',process.argv[1]],{stdio:'inherit'})";
  const stopped = assert.rejects(
    command(process.execPath, ['-e', launch, callback], {
      cwd: dir,
      signal: controller.signal,
    }),
    /abort/i,
  );
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(dir, 'ready')) && Date.now() < deadline)
      await delay(20);
    assert.ok(existsSync(join(dir, 'ready')));
    controller.abort();
    await stopped;
    await delay(1300);
    assert.equal(existsSync(join(dir, 'late')), false);
  } finally {
    controller.abort();
    await stopped;
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

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
          RIGHT: [[1, 2]],
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
      HTTP_PROXY: 'http://proxy.example',
      https_proxy: 'http://secure-proxy.example',
      ALL_PROXY: 'socks5://proxy.example',
      no_proxy: 'localhost',
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
  assert.equal(env.HTTP_PROXY, 'http://proxy.example');
  assert.equal(env.https_proxy, 'http://secure-proxy.example');
  assert.equal(env.ALL_PROXY, 'socks5://proxy.example');
  assert.equal(env.no_proxy, 'localhost');
  assert.deepEqual(confirmedRules(['types'], ['package.json']), []);
  assert.deepEqual(confirmedRules(['types'], ['src/index.ts']), ['types']);
});

test('only Important candidates run a fresh verifier, with strict schema, diff and candidate checks', async () => {
  let calls = 0;
  const noIssues = await review(snapshot, input, undefined, async () => {
    calls++;
    return result([]);
  });
  assert.equal(calls, 1);
  assert.deepEqual(noIssues.findings, []);
  const decision = {
    finding_id: finding.finding_id,
    verdict: 'drop',
    evidence: 'The caller already checks the precondition.',
  };
  const adjudicate = (decisions) =>
    review(
      snapshot,
      input,
      undefined,
      async (_snapshot, _prompt, _signal, verify) =>
        verify ? { decisions } : result([finding]),
    );
  const dropped = await adjudicate([decision]);
  assert.equal(dropped.dropped, 1);
  const confirmed = await adjudicate([
    {
      ...decision,
      verdict: 'confirm',
      evidence: 'diff.ts calls the operation before checking the precondition.',
    },
  ]);
  assert.equal(confirmed.findings[0].finding_id, finding.finding_id);
  assert.match(confirmed.findings[0].evidence, /diff\.ts/);
  await assert.rejects(adjudicate([]), /Missing verifier decision/);
  await assert.rejects(
    adjudicate([decision, decision]),
    /Invalid verifier decision/,
  );
  await assert.rejects(
    adjudicate([{ ...decision, verdict: 'unverifiable' }]),
    /Review evidence unavailable/,
  );
  const discussion = { ...input, threads: [{ id: 'thread' }] };
  await assert.rejects(
    review(snapshot, discussion, undefined, async () => result([])),
    /Missing open thread/,
  );
  const retained = await review(snapshot, discussion, undefined, async () =>
    result(
      [],
      [
        {
          thread_id: 'thread',
          disposition: 'open',
          evidence: 'Awaiting evidence',
        },
      ],
    ),
  );
  assert.equal(retained.threads[0].disposition, 'open');
  await assert.rejects(
    review(snapshot, input, undefined, async () => ({ findings: [] })),
    /schema/,
  );
  await assert.rejects(
    adjudicate([{ ...decision, finding_id: 'other' }]),
    /Invalid verifier decision/,
  );
});

test('mixed reviews publish only GitHub-addressable Important lines and retain summary-only findings on changed files', async () => {
  const anchors = changedLines(
    [
      '@@ -2,4 +2,3 @@',
      ' unchanged',
      '-old',
      '-also old',
      '+new',
      ' unchanged',
      '@@ -17 +16,0 @@',
      '-last',
      '\\ No newline at end of file',
    ].join('\n'),
  );
  assert.deepEqual(anchors, {
    LEFT: [
      [3, 4],
      [17, 17],
    ],
    RIGHT: [[2, 4]],
  });
  const mixed = [
    { ...finding, finding_id: 'context', line: 2 },
    {
      ...finding,
      finding_id: 'deletion',
      bug_class: 'old-code',
      side: 'LEFT',
      line: 17,
    },
    { ...finding, finding_id: 'nit', severity: 'Nit', line: 9 },
    { ...finding, finding_id: 'existing', severity: 'Pre-existing', line: 8 },
    {
      ...finding,
      finding_id: 'missing',
      severity: 'Nit',
      file: 'untouched.ts',
    },
  ];
  const mixedSnapshot = {
    ...snapshot,
    anchors: new Map([['diff.ts', anchors]]),
  };
  for (const location of [
    { side: 'LEFT', line: 2 },
    { line: 7 },
    { file: 'untouched.ts' },
  ])
    await assert.rejects(
      review(mixedSnapshot, input, undefined, async () =>
        result([{ ...finding, ...location }]),
      ),
      /Important finding outside the PR diff/,
    );
  const reviewed = await review(
    mixedSnapshot,
    input,
    undefined,
    async (_snapshot, _prompt, _signal, verify) =>
      verify
        ? {
            decisions: ['context', 'deletion'].map((finding_id) => ({
              finding_id,
              verdict: 'confirm',
              evidence: 'Confirmed by the caller.',
            })),
          }
        : result(mixed),
  );
  assert.equal(reviewed.omittedAdvisories, 1);
  assert.deepEqual(
    reviewed.findings.map((f) => f.finding_id),
    ['context', 'deletion', 'nit', 'existing'],
  );
  const comments = [];
  let body;
  const api = {
    review: async (_pr, _head, pending) => comments.push(...pending),
    summary: async (_pr, _id, text) => {
      body = text;
    },
  };
  await publish(api, pr, state, 'worker', [], snapshot, reviewed, ok);
  assert.deepEqual(
    comments.map(({ side, line }) => [side, line]),
    [
      ['RIGHT', 2],
      ['LEFT', 17],
    ],
  );
  assert.match(body, /Omitted 1 advisory finding/);
  const incomplete = await review(snapshot, input, undefined, async () =>
    result([{ ...finding, severity: 'Pre-existing', file: 'untouched.ts' }]),
  );
  await publish(api, pr, state, 'worker', [], snapshot, incomplete, ok);
  assert.match(body, /Omitted 1 advisory finding/);
  assert.doesNotMatch(body, /0 issues/);
  assert.equal(comments.length, 2);
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
  assert.equal(eligible({ ...read, head: 'b'.repeat(40) }, head), false);
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
  let latest = read;
  for (const attempted of ['b'.repeat(40), 'c'.repeat(40)]) {
    await skipped(
      api,
      { ...pr, head: { sha: attempted } },
      latest,
      'timeout',
      ok,
    );
    const body = summaries.at(-1)[2];
    latest = sticky([{ ...owned, body }], 'worker');
    assert.equal(latest.round, 1);
    assert.equal(latest.head, head);
    assert.equal(latest.failed, attempted);
    assert.equal(latest.completedSummary, read.completedSummary);
    assert.match(body, /\| Important \| diff\.ts/);
    assert.match(body, /\| Nit \| diff\.ts/);
    assert.equal(body.split('AI Review Skipped').length - 1, 1);
    assert.equal(body.split('## Last completed review').length - 1, 1);
  }
  const next = { ...pr, head: { sha: latest.failed } };
  await publish(
    api,
    next,
    latest,
    'worker',
    [],
    snapshot,
    { ...result([]), dropped: 0 },
    ok,
  );
  const recovered = summaries.at(-1)[2];
  assert.doesNotMatch(recovered, /AI Review Skipped|Last completed review/);
  assert.equal(sticky([{ ...owned, body: recovered }], 'worker').round, 2);
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
    root: { fullDatabaseId: '4708031212' },
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
