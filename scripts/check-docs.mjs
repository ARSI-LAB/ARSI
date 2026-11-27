import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkExamples } from './check-docs-examples.mjs';
import {
  historicalProse,
  parseMarkdown,
  relativeTarget,
} from './check-docs-markdown.mjs';

const budgets = { 'AGENTS.md': [160, 25_000], 'docs/AGENTS.md': [60, 8_000] };

function partner(file) {
  if (file === 'README.md') return 'README.zh-CN.md';
  if (file === 'README.zh-CN.md') return 'README.md';
  if (file.startsWith('docs/users/') && file.endsWith('.md')) {
    return file.endsWith('_zh.md')
      ? file.replace(/_zh\.md$/, '.md')
      : file.replace(/\.md$/, '_zh.md');
  }
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commit(root, ref) {
  return git(
    root,
    'rev-parse',
    '--verify',
    '--end-of-options',
    ref + '^{commit}',
  ).trim();
}

function changedFiles(root, base, head) {
  const fields = git(
    root,
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    base,
    ...(head ? [head] : []),
    '--',
  ).split('\0');
  const changes = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++][0];
    const before = fields[i++];
    const after = status === 'R' ? fields[i++] : before;
    changes.push({ status, before, after });
  }
  return changes;
}

function validRecord(file) {
  const match =
    /^docs\/(design|tasks)\/(\d{4}-\d{2}-\d{2})\/\2-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(
      file,
    );
  if (!match || (match[1] === 'tasks' && !match[3].includes('-'))) return false;
  const date = new Date(match[2] + 'T00:00:00Z');
  return (
    Number.isFinite(date.valueOf()) &&
    date.toISOString().startsWith(match[2] + 'T')
  );
}

function checkFormatting(file, bytes, report) {
  if (
    !isUtf8(bytes) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  ) {
    report(file, 1, 'Save Markdown as UTF-8 without a byte order mark.');
  }
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) !== '') {
    report(file, lines.length, 'End Markdown files with a final newline.');
  }
  for (const [i, line] of lines.entries()) {
    if (line.includes('\r')) report(file, i + 1, 'Use LF line endings.');
    const trailing = /[ \t]+$/.exec(line.replace(/\r$/, ''))?.[0];
    if (trailing && (trailing.includes('\t') || trailing.length === 1)) {
      report(
        file,
        i + 1,
        'Remove trailing whitespace or use two spaces for a Markdown hard break.',
      );
    }
  }
}

export function checkDocs(
  root,
  { base = 'HEAD', head, today = new Date().toISOString().slice(0, 10) } = {},
) {
  const errors = [];
  const report = (file, line, problem) =>
    errors.push(file + ':' + line + ': ' + problem);
  const baseSha = commit(root, base);
  const changes = changedFiles(root, baseSha, head && commit(root, head));
  const paths = new Set(
    changes.flatMap(({ before, after }) => [before, after]),
  );
  const tracked = git(root, 'ls-files', '-z', '--', '*.md')
    .split('\0')
    .filter(Boolean);
  const cache = new Map();
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  function markdown(file) {
    if (!cache.has(file)) cache.set(file, parseMarkdown(read(file)));
    return cache.get(file);
  }
  function target(file, link) {
    try {
      return relativeTarget(file, link.value);
    } catch {
      report(
        file,
        link.line,
        'Invalid URL encoding in ' +
          link.value +
          '. Encode the path and anchor correctly.',
      );
    }
  }
  for (const [file, [maxLines, maxBytes]] of Object.entries(budgets)) {
    if (!existsSync(path.join(root, file))) {
      report(file, 1, 'Restore the repository rule document.');
      continue;
    }
    const text = read(file);
    const lines = text.split('\n').length - Number(text.endsWith('\n'));
    if (lines > maxLines || Buffer.byteLength(text) > maxBytes) {
      report(
        file,
        Math.min(lines, maxLines + 1),
        'Keep rule documents within ' +
          maxLines +
          ' lines and ' +
          maxBytes +
          ' bytes. Move details into a guide or an automated check.',
      );
    }
  }
  for (const file of paths) {
    const other = partner(file);
    if (other && !paths.has(other))
      report(
        file,
        1,
        'Update the paired translation ' + other + ' in the same change.',
      );
  }
  const guides = new Map();
  for (const file of new Set([...tracked, 'README.md', 'README.zh-CN.md'])) {
    const other = partner(file);
    if (!other) continue;
    if (!existsSync(path.join(root, file))) {
      if (!file.includes('/'))
        report(file, 1, 'Restore the root README translation pair.');
      continue;
    }
    const doc = markdown(file);
    guides.set(file, doc);
    if (!existsSync(path.join(root, other))) {
      report(file, 1, 'Add the missing paired translation ' + other + '.');
      continue;
    }
    if (
      !doc.links.some((link) => {
        const dest = target(file, link);
        return (
          dest?.target === other &&
          (!dest.fragment || markdown(other).anchors.has(dest.fragment))
        );
      })
    ) {
      report(file, 1, 'Add a language-switch link to ' + other + '.');
    }
    if (file > other) continue;
    const translated = markdown(other).headings;
    const mismatch = doc.headings.findIndex(
      (heading, i) => heading.level !== translated[i]?.level,
    );
    if (mismatch !== -1 || doc.headings.length !== translated.length) {
      report(
        file,
        doc.headings[mismatch]?.line ?? 1,
        'Match the heading levels and section count in ' + other + '.',
      );
    }
  }
  for (const { status, before, after } of changes) {
    if (status === 'D' || !after.toLowerCase().endsWith('.md')) continue;
    checkFormatting(after, readFileSync(path.join(root, after)), report);
    if (/^docs\/(?:design|tasks)\//.test(after) && !validRecord(after)) {
      report(
        after,
        1,
        'Place the record in its YYYY-MM-DD directory with a matching dated topic filename (include a type for task records).',
      );
    }
    const oldDate =
      /^docs\/(?:design|tasks)\/(?:\d{4}-\d{2}-\d{2}\/)?(\d{4}-\d{2}-\d{2})-/.exec(
        before,
      )?.[1];
    if (status !== 'A' && oldDate && oldDate < today) {
      const previous = git(root, 'show', baseSha + ':' + before);
      const oldLines = historicalProse(previous).split('\n');
      const newLines = historicalProse(read(after)).split('\n');
      const mismatch = newLines.findIndex((value, i) => value !== oldLines[i]);
      if (mismatch !== -1 || oldLines.length !== newLines.length) {
        report(
          after,
          mismatch === -1 ? newLines.length : mismatch + 1,
          'Preserve historical prose. Record later decisions in a new dated file; only path repairs and retention removal are permitted.',
        );
      }
    }
    for (const link of markdown(after).links) {
      const destination = target(after, link);
      if (!destination) continue;
      const { target: dest, fragment } = destination;
      const absolute = path.resolve(root, dest);
      const rel = path.relative(root, absolute);
      if (
        rel.startsWith('..' + path.sep) ||
        rel === '..' ||
        path.isAbsolute(rel) ||
        !existsSync(absolute)
      ) {
        report(
          after,
          link.line,
          'Fix the relative link to missing repository target ' +
            link.value +
            '.',
        );
        continue;
      }
      if (!fragment) continue;
      const md = statSync(absolute).isDirectory()
        ? path.posix.join(dest, 'README.md')
        : dest;
      if (
        /\.md$/i.test(md) &&
        !(existsSync(path.join(root, md)) && markdown(md).anchors.has(fragment))
      ) {
        report(
          after,
          link.line,
          'Fix the missing heading or named anchor in ' + link.value + '.',
        );
      }
    }
  }
  checkExamples(root, guides, report);
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, head: { type: 'string' } },
  });
  const errors = checkDocs(process.cwd(), {
    base: values.base ?? process.env.RSI_CI_BASE_SHA,
    head: values.head ?? process.env.RSI_CI_HEAD_SHA,
  });
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Documentation checks passed.');
}
