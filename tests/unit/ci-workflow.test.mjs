import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const { jobs } = parse(
  readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
);

test('only nonempty diffs confined to docs or root Markdown take the documentation shortcut', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arsi-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '--quiet');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const scope = jobs.fast.steps.find((step) => step.id === 'scope');
  writeFileSync(path.join(root, '.git/scope.sh'), scope.run);

  function write(file) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), file);
  }
  function check(expected, scenario) {
    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '-m', scenario);
    writeFileSync(path.join(root, '.git/output'), '');
    // Git supplies Bash on Windows, the same shell used by the workflow.
    execFileSync('git', ['-c', 'alias.scope=!bash .git/scope.sh', 'scope'], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'merge_group',
        RSI_CI_BASE_SHA: 'HEAD^',
        RSI_CI_HEAD_SHA: 'HEAD',
        RUNNER_TEMP: '.git',
        GITHUB_OUTPUT: '.git/output',
      },
    });
    const output = readFileSync(path.join(root, '.git/output'), 'utf8');
    assert.equal(/^docs=(.*)$/m.exec(output)?.[1], String(expected), scenario);
  }

  write('README.md');
  write('docs/assets/a figure.png');
  check(true, 'root Markdown and nested documentation');
  for (const file of [
    'src/policies/harness2/prompts/input.md',
    '.github/review/system-prompt.md',
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
  rmSync(path.join(root, '.github/review/system-prompt.md'));
  write('docs/guide.md');
  check(false, 'production deletion mixed with documentation');
  write('package.json');
  check(false, 'root non-Markdown');
  check(false, 'empty diff');
});

test('the Windows check reports documentation-only PRs and runs its work for other changes', () => {
  assert.equal(jobs.fast.outputs.docs, '${{ steps.scope.outputs.docs }}');
  const windows = jobs.windows;
  assert.equal(windows.if, undefined);
  assert.equal(windows.needs, 'fast');
  const report = windows.steps.filter(
    (step) => step.if === "needs.fast.outputs.docs == 'true'",
  );
  assert.equal(report.length, 1);
  assert.match(report[0].run, /^echo /);
  const work = windows.steps.filter(
    (step) => step.if === "needs.fast.outputs.docs != 'true'",
  );
  assert.equal(work.length + report.length, windows.steps.length);
  assert.ok(work.some((step) => step.run === 'pnpm test'));
});
