import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const { jobs, on, concurrency } = parse(
  readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
);

test('drafts skip CI and both readiness transitions trigger a run in the same PR group', () => {
  assert.deepEqual(
    new Set(on.pull_request.types),
    new Set([
      'opened',
      'reopened',
      'synchronize',
      'ready_for_review',
      'converted_to_draft',
    ]),
  );
  assert.deepEqual(on.merge_group.types, ['checks_requested']);
  assert.equal(
    concurrency.group,
    'quality-${{ github.event.pull_request.number || github.ref }}',
  );
  assert.equal(concurrency['cancel-in-progress'], true);
  assert.equal(jobs.scope.if, 'github.event.pull_request.draft != true');
  assert.equal(
    jobs.windows.if,
    '${{ !cancelled() && github.event.pull_request.draft != true }}',
  );
});

// Git supplies Bash on Windows, the same shell used by the workflow.
function runBash(script, env, cwd) {
  const result = spawnSync(
    'git',
    ['-c', 'alias.ci-script=!bash', 'ci-script'],
    {
      cwd,
      env: { ...process.env, ...env },
      input: script,
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  return result;
}

test('only nonempty diffs confined to docs or root Markdown take the documentation shortcut', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arsi-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const initial = git('rev-parse', 'HEAD');
  const scope = jobs.scope.steps.find((step) => step.id === 'scope');

  function write(file) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), file);
  }
  function classify(event, base, head) {
    writeFileSync(path.join(root, '.git/output'), '');
    const run = runBash(
      scope.run,
      {
        GITHUB_EVENT_NAME: event,
        RSI_CI_BASE_SHA: base,
        RSI_CI_HEAD_SHA: head,
        RUNNER_TEMP: '.git',
        GITHUB_OUTPUT: '.git/output',
      },
      root,
    );
    assert.equal(run.status, 0, run.stderr);
    return Object.fromEntries(
      readFileSync(path.join(root, '.git/output'), 'utf8')
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => line.split('=')),
    );
  }
  function check(docs, scenario) {
    const base = git('rev-parse', 'HEAD');
    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '-m', scenario);
    const head = git('rev-parse', 'HEAD');
    const output = classify('merge_group', base, head);
    assert.equal(output.docs, String(docs), scenario);
    assert.equal(output.base_sha, base);
    assert.equal(output.head_sha, head);
    return output;
  }

  write('README.md');
  write('docs/assets/a figure.png');
  check(true, 'root Markdown and nested documentation');
  for (const file of [
    'src/policies/harness2/prompts/input.md',
    '.github/review/skill/SKILL.md',
    'examples/harness/guide.md',
    'skills/editor/SKILL.md',
  ]) {
    write(file);
    check(false, file);
  }
  renameSync(
    path.join(root, 'skills/editor/SKILL.md'),
    path.join(root, 'docs/skill.md'),
  );
  check(false, 'rename from a production path into docs');
  rmSync(path.join(root, '.github/review/skill/SKILL.md'));
  write('docs/guide.md');
  check(false, 'production deletion mixed with documentation');
  write('package.json');
  check(false, 'root non-Markdown');
  check(false, 'empty diff');
  write('.github/workflows/ci.yml');
  const workflow = check(
    false,
    'workflow changes run package and bridge checks',
  );
  assert.equal(workflow.package, 'true');
  assert.equal(workflow.bridge, 'true');

  write('docs/last.md');
  const last = check(true, 'documentation on a newer merge base');
  assert.equal(last.package, 'false');
  assert.equal(last.bridge, 'false');
  // The merge ref can be rebuilt on a newer base than the event payload.
  const pr = classify('pull_request', initial, last.head_sha);
  assert.deepEqual(pr, last);
  // Merge groups may span more than the last commit.
  const group = classify('merge_group', initial, last.head_sha);
  assert.deepEqual(group, {
    ...workflow,
    base_sha: initial,
    head_sha: last.head_sha,
  });
});

test('Linux checks, packaging and Windows shards depend only on path detection and use the pnpm store cache', () => {
  const { scope, check, windows_shard: shard } = jobs;
  assert.equal(scope.name, 'CI / Detect changes');
  assert.equal(scope.env.RSI_CI_HEAD_SHA, '${{ github.sha }}');
  assert.equal(
    scope.env.RSI_CI_BASE_SHA,
    '${{ github.event.merge_group.base_sha }}',
  );
  for (const output of ['docs', 'package', 'bridge', 'base_sha', 'head_sha']) {
    assert.equal(
      scope.outputs[output],
      '${{ steps.scope.outputs.' + output + ' }}',
    );
  }
  assert.equal(
    check.env.RSI_CI_BASE_SHA,
    '${{ needs.scope.outputs.base_sha }}',
  );
  assert.equal(
    check.env.RSI_CI_HEAD_SHA,
    '${{ needs.scope.outputs.head_sha }}',
  );
  assert.equal(check.name, 'CI / Check (Linux)');
  for (const [name, command] of [
    ['Run documentation checks', 'pnpm check:docs'],
    ['Run full checks', 'pnpm check'],
    [
      'Run bridge tests',
      'python3 -m unittest discover -s .github/workflows/bridge/tests',
    ],
  ]) {
    assert.equal(check.steps.find((step) => step.name === name)?.run, command);
  }
  assert.equal(jobs.package.name, 'CI / Package');
  assert.equal(jobs.package.if, undefined);
  for (const job of [check, jobs.package, shard]) {
    assert.equal(job.needs, 'scope');
    const pnpm = job.steps.findIndex((step) =>
      step.uses?.startsWith('pnpm/action-setup@'),
    );
    const node = job.steps.findIndex((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    );
    const install = job.steps.findIndex((step) =>
      step.run?.startsWith('pnpm install --frozen-lockfile'),
    );
    assert.ok(pnpm >= 0 && pnpm < node && node < install, job.name);
    assert.equal(job.steps[node].with.cache, 'pnpm');
    assert.equal(job.steps[node].with['node-version'], 24);
  }
  assert.equal(shard.name, 'CI / Test (Windows ${{ matrix.shard }}/3)');
  assert.equal(shard['runs-on'], 'windows-latest');
  assert.equal(shard.if, "needs.scope.outputs.docs != 'true'");
  assert.deepEqual(shard.strategy, {
    'fail-fast': false,
    matrix: { shard: [1, 2, 3] },
  });
  const unit = shard.steps.find((step) => step.run?.includes('--test-shard'));
  assert.equal(unit.shell, 'bash');
  assert.equal(
    unit.run.trim(),
    'node --import tsx --test --test-shard=${{ matrix.shard }}/3 tests/unit/*.test.ts tests/unit/*.test.mjs',
  );
});

test('the required Windows check succeeds only for a successful scope and docs or all shards passing', () => {
  const job = jobs.windows;
  assert.equal(job.name, 'CI / Test (Windows)');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.needs, ['scope', 'windows_shard']);
  const summary = job.steps.find((step) => step.run);
  assert.deepEqual(summary.env, {
    SCOPE_RESULT: '${{ needs.scope.result }}',
    DOCS: '${{ needs.scope.outputs.docs }}',
    SHARD_RESULT: '${{ needs.windows_shard.result }}',
  });
  for (const [scope, docs, shards, expected] of [
    ['success', 'true', 'skipped', 0],
    ['success', 'false', 'success', 0],
    ['success', 'false', 'failure', 1],
    ['success', 'false', 'skipped', 1],
    ['failure', 'true', 'skipped', 1],
  ]) {
    const run = runBash(summary.run, {
      SCOPE_RESULT: scope,
      DOCS: docs,
      SHARD_RESULT: shards,
    });
    assert.equal(
      run.status,
      expected,
      [scope, docs, shards, run.stderr].join(' '),
    );
    if (expected === 0 && docs === 'true')
      assert.match(run.stdout, /Only documentation changed\./);
  }
});
