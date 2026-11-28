import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDocs } from '../../scripts/check-docs.mjs';

test('documentation gates accept a synchronized guide and pinpoint independent regressions', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arsi-doc-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function git(...args) {
    return execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  }
  function write(file, body) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  const check = (options = {}) =>
    checkDocs(root, { today: '2026-11-27', ...options });
  const original = 'docs/design/2026-11-25/2026-11-25-ci.md';
  const task = 'docs/tasks/2026-11-26/2026-11-26-test-ci.md';
  const guide = 'docs/users/example.md';
  const chinese = 'docs/users/example_zh.md';
  const code = (info, value) =>
    '\x60\x60\x60' + info + '\n' + value + '\n\x60\x60\x60';
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  write(
    'package.json',
    JSON.stringify({
      name: 'arsi',
      type: 'module',
      exports: { './contracts': { types: './dist/src/contracts/index.d.ts' } },
    }),
  );
  write('AGENTS.md', '# Rules\n');
  write('docs/AGENTS.md', '# Docs\n');
  write('README.md', '<a href="./README.zh-CN.md">中文</a>\n# Top\n');
  write('README.zh-CN.md', '[English](README.md)\n# 顶部\n');
  write(original, '# Design\nSee [guide](../../users/example.md).\n');
  write(task, '# Task\n');
  write('src/contracts/index.ts', 'export type Example = { count: number };');
  write(guide, '[中文](example_zh.md)\n## Hello\n');
  write(chinese, '[English](example.md)\n## 你好\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');

  write(original, '# Design\nSee [guide](../../users/example_zh.md#你好).\n');
  git('rm', '--quiet', task);
  write(
    guide,
    [
      '[中文](example_zh.md)',
      '## Hello',
      '## Hello',
      '[duplicate heading](#hello-1)',
      '[translated section][target]',
      '[target]: example_zh.md#%E4%BD%A0%E5%A5%BD',
      'Inline example: \x60[link](missing.md)\x60',
      code('md', '# Ignore\n[ignored](missing.md)'),
      code(
        'ts file=data.ts',
        "import type { Example } from 'arsi/contracts';\nexport const data: Example = { count: 1 };",
      ),
      code(
        'typescript',
        "import { data } from './data.js';\ndata.count.toFixed();",
      ),
      code('ts ignore-check', 'hypothetical.call()'),
      'A Markdown hard break follows.  ',
      'Next line.',
      '',
    ].join('\n'),
  );
  write(chinese, '[English](example.md)\n## 你好\n## 你好\n');
  git('add', '.');
  git('commit', '-qm', 'paired docs and link repair');
  assert.deepEqual(check({ base, head: 'HEAD' }), []);

  const badRecord = 'docs/tasks/2026-11-27/2026-11-27-topic.md';
  write(badRecord, '# No task type\n');
  git('add', badRecord);
  write(original, '# Rewritten design\nSee [guide](../../users/example.md).\n');
  write(
    'format.md',
    Buffer.concat([Buffer.from([0xff]), Buffer.from(' \r\nline\t\nend')]),
  );
  git('add', 'format.md');
  write(
    guide,
    [
      '[bad](example_zh.md#missing)',
      '## Hello',
      '[missing](absent.md)',
      code(
        'typescript',
        "import type { Example } from 'arsi/contracts';\nconst broken: Example = { count: 'one' };",
      ),
    ].join('\n'),
  );
  write('README.md', '# Top\n');
  write('docs/AGENTS.md', 'x'.repeat(8001));
  write('AGENTS.md', 'line\n'.repeat(161));
  write('docs/users/orphan_zh.md', '# 没有对应指南\n');
  git('add', 'docs/users/orphan_zh.md');
  const errors = check().join('\n');
  for (const message of [
    /README\.md:1: Add a language-switch link/,
    /example\.md:1: Update the paired translation/,
    /example\.md:1: Match the heading levels/,
    /example\.md:1: Fix the missing heading/,
    /example\.md:3: Fix the relative link/,
    /example\.md:6: TS2322/,
    /orphan_zh\.md:1: Add the missing paired translation/,
    /ci\.md:1: Preserve historical prose/,
    /topic\.md:1: Place the record/,
    /AGENTS\.md:161: Keep rule documents/,
    /docs\/AGENTS\.md:1: Keep rule documents/,
    /format\.md:1: Save Markdown as UTF-8/,
    /format\.md:1: Use LF line endings/,
    /format\.md:1: Remove trailing whitespace/,
    /format\.md:2: Remove trailing whitespace/,
    /format\.md:3: End Markdown files/,
  ])
    assert.match(errors, message);
});
