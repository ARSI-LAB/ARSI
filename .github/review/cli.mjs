#!/usr/bin/env node
// Launch this entrypoint from a maintainer-controlled checkout. Only Git objects from
// the fetched origin/master supply executable Worker modules, prompts and schemas.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: 'boolean' },
    manual: { type: 'boolean' },
    repo: { type: 'string' },
    pr: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const mode = positionals[0];
const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM'])
  process.once(event, () => controller.abort());
const signal = controller.signal;
const git = async (...args) =>
  (
    await execute(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { signal, timeout: 120000, windowsHide: true, encoding: 'utf8' },
    )
  ).stdout;

async function main() {
  if (values.help) {
    console.log(
      'review:local | review:worker [--once] [--repo OWNER/REPO] [--pr NUMBER] [--manual]',
    );
    return;
  }
  if (
    positionals.length !== 1 ||
    !['local', 'worker'].includes(mode) ||
    (values.pr && !/^[1-9]\d*$/.test(values.pr)) ||
    (values.manual && !values.pr) ||
    (mode === 'local' && Object.keys(values).length)
  )
    throw new Error('Invalid review options. See --help.');
  const root = (await git('rev-parse', '--show-toplevel')).trim();
  const origin = (await git('remote', 'get-url', 'origin')).trim();
  const match = origin.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
  );
  if (
    !match ||
    (values.repo && match[1].toLowerCase() !== values.repo.toLowerCase())
  )
    throw new Error(
      'origin must point to the selected GitHub repository; use a trusted checkout of that repository.',
    );
  const repo = match[1];
  const remote = 'https://github.com/' + repo + '.git';
  const once = mode === 'local' || values.once || values.pr;
  do {
    let dir;
    try {
      await git(
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        '+refs/heads/master:refs/remotes/origin/master',
      );
      const trusted = (
        await git('rev-parse', 'refs/remotes/origin/master^{commit}')
      ).trim();
      dir = await mkdtemp(join(tmpdir(), 'arsi-review-worker-'));
      const files = (
        await git('ls-tree', '--name-only', trusted + ':.github/review')
      )
        .trim()
        .split('\n')
        .filter((file) => /^[a-z-]+\.mjs$/.test(file) && file !== 'cli.mjs');
      for (const file of files)
        await writeFile(
          join(dir, file),
          await git('show', trusted + ':.github/review/' + file),
        );
      const { run } = await import(pathToFileURL(join(dir, 'worker.mjs')).href);
      await run({
        mode,
        root,
        trusted,
        remote,
        repo,
        pr: values.pr && Number(values.pr),
        manual: values.manual,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      if (once) throw error;
      console.error(
        'Review poll failed. Check origin/master, gh authentication and review configuration. Retrying in 60 seconds.',
      );
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    if (!once) await delay(60000, undefined, { signal });
  } while (!once && !signal.aborted);
}

try {
  await main();
} catch (error) {
  if (!signal.aborted) {
    console.error('Review failed: ' + String(error.message).split('\n')[0]);
    process.exitCode = 1;
  }
}
