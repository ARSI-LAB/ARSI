import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { withContext } from '@logtape/logtape';
import stringWidth from 'string-width';
import {
  cliLogger,
  configureCliLogging,
  parseLogLevels,
  runtimeLogger,
} from '../../src/entries/cli/logging/index.js';
import { renderBanner } from '../../src/entries/cli/ui/banner.js';
import {
  parseShellLine,
  splitCommandLine,
} from '../../src/entries/cli/ui/shell-parser.js';
import { runWithSpinner } from '../../src/entries/cli/ui/task-runner.js';
import { reportTaskProgress } from '../../src/shared/task-progress.js';

test('log levels use the most specific category and quiet still permits logging to a file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'arsi-clack-logs-'));
  const logFile = join(root, 'cli.log');
  const terminal: string[] = [];
  const logging = configureCliLogging(false, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const logLevel = parseLogLevels('cli.runtime=trace', parseLogLevels('warn'));
  await logging.run({ logLevel, logFile }, () =>
    withContext({ command: 'list' }, async () => {
      await Promise.resolve();
      cliLogger.info('hidden');
      runtimeLogger.trace('opening details');
    }),
  );
  await logging.run({ logLevel, logFile, quiet: true }, async () => {
    runtimeLogger.debug('file only');
    cliLogger.error('visible error');
  });
  assert.match(terminal.join(''), /TRACE.*\[list\].*opening details/);
  assert.match(terminal.join(''), /ERROR.*visible error/);
  assert.doesNotMatch(terminal.join(''), /hidden|file only/);
  const saved = await readFile(logFile, 'utf8');
  assert.match(saved, /file only/);
  assert.doesNotMatch(saved, /hidden/);
});

test('banner shows version and environment, and shell syntax preserves quoted arguments', () => {
  const banner = renderBanner({
    version: '1.2.3',
    workspace: 'test workspace',
    level: 'info',
  });
  assert.match(banner, /ARSI 1\.2\.3.*Node v\d+/);
  assert.match(banner, /Workspace test workspace/);
  assert.match(banner, /Log level info/);
  assert.deepEqual(
    splitCommandLine(
      String.raw`run "C:\My Recipes\test.yaml" --id 'test run' --plugin-dir ""`,
    ),
    [
      'run',
      'C:\\My Recipes\\test.yaml',
      '--id',
      'test run',
      '--plugin-dir',
      '',
    ],
  );
  assert.deepEqual(parseShellLine('arsi help reflection'), {
    kind: 'builtin',
    name: 'help',
    args: ['reflection'],
  });
  assert.deepEqual(parseShellLine('catalog'), {
    kind: 'command',
    argv: ['catalog'],
  });
  assert.throws(
    () => parseShellLine('run "unfinished'),
    /Unclosed double quote/,
  );
  assert.deepEqual(
    splitCommandLine(
      '"C:\\My Data\\\\" "\\\\wsl.localhost\\Ubuntu\\home\\ARSI\\\\" "/mnt/d/My Data/"',
    ),
    [
      'C:\\My Data\\',
      '\\\\wsl.localhost\\Ubuntu\\home\\ARSI\\',
      '/mnt/d/My Data/',
    ],
  );
  assert.deepEqual(splitCommandLine('"one\\"two"'), ['one"two']);
});

test('the banner places the README flame beside text when color and width are available', () => {
  const options = {
    version: '1.2.3',
    workspace: 'test workspace',
    level: 'info',
    color: true,
  };
  const wide = renderBanner({ ...options, columns: 80 });
  assert.match(wide, /\x1b\[38;5;202(?:;|m)[^\n]*[▀▄█]/);
  assert.match(stripVTControlCharacters(wide), /[▀▄█][^\n]*ARSI 1\.2\.3/);
  for (const banner of [
    renderBanner({ ...options, columns: 30 }),
    renderBanner({ ...options, color: false }),
  ]) {
    assert.match(banner, /Workspace test workspace/);
    assert.doesNotMatch(banner, /[▀▄█]/);
  }
});

test('the same reason is retained for independent calls and deduplicated along a parent chain', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'arsi-cli-error-chains-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const logFile = join(workspace, 'errors.log');
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  const reason = 'same failure reason';
  await logging.run(
    { logFile },
    async () => {
      runtimeLogger.debug('parent started', {
        callId: 'parent',
        parentCallId: 'root',
      });
      runtimeLogger.debug('wrapper started', {
        callId: 'wrapper',
        parentCallId: 'parent',
      });
      runtimeLogger.error('child failed', {
        callId: 'child',
        parentCallId: 'wrapper',
        error: reason,
      });
      runtimeLogger.error('parent failed', {
        callId: 'parent',
        parentCallId: 'root',
        error: reason,
      });
      runtimeLogger.error('independent failed', {
        callId: 'independent',
        parentCallId: 'root',
        error: reason,
      });
    },
    { command: 'run' },
  );
  assert.match(terminal.join(''), /child failed: same failure reason/);
  assert.match(terminal.join(''), /independent failed: same failure reason/);
  assert.doesNotMatch(terminal.join(''), /parent failed: same failure reason/);
  assert.equal((await readFile(logFile, 'utf8')).split(reason).length - 1, 2);
});

test('Ora follows live calls and prints Cargo records during foreground work', async (t) => {
  const logging = configureCliLogging(true);
  t.after(() => logging.dispose());
  let output = '';
  const frames: string[] = [];
  const terminal = Object.assign(
    new Writable({
      write(buffer: Buffer, _encoding, done) {
        const text = buffer.toString();
        output += text;
        if (text.includes('Running '))
          frames.push(stripVTControlCharacters(text));
        done();
      },
    }),
    {
      isTTY: true as const,
      columns: 100,
      rows: 30,
      cursorTo: () => true,
      clearLine: () => true,
      moveCursor: () => true,
    },
  );
  t.after(() => {
    terminal.destroy();
  });
  const activeTask = { id: 'test', label: 'evaluator (baseline)' };
  await runWithSpinner(
    logging,
    () =>
      logging.run(
        { noLogFile: true },
        async () => {
          runtimeLogger.debug('Opening runtime');
          runtimeLogger.debug('Running {label}', { ...activeTask, activeTask });
          cliLogger.warn('Transient network error');
          terminal.columns = 58;
          terminal.emit('resize');
          reportTaskProgress(
            runtimeLogger,
            activeTask.id,
            '检查中\n' + '界🌐'.repeat(30),
          );
          cliLogger.info('evaluator · 1/2 task-a completed', {
            stage: 'Progress',
          });
          runtimeLogger.info('{label} 0.0s', {
            label: activeTask.label,
            stage: 'Completed',
            activeTask: { ...activeTask, done: true },
          });
        },
        { command: 'run' },
      ),
    terminal,
  );
  const plain = stripVTControlCharacters(output);
  assert.match(plain, /Running evaluator \(baseline\) · \d+\.\ds/);
  assert.match(plain, / {3}Warning Transient network error/);
  assert.match(plain, / {2}Progress evaluator · 1\/2 task-a completed/);
  const updated = frames.find((frame) => frame.includes('检查中'));
  assert.ok(updated);
  assert.match(
    updated,
    /Running evaluator \(baseline\) · 检查中 .*… · \d+\.\ds$/u,
  );
  assert.ok(stringWidth(updated) < terminal.columns);
  assert.equal(output.match(/\x1b\[\?25l/g)?.length, 1);
  assert.match(plain, / Completed evaluator \(baseline\) 0\.0s/);
  assert.doesNotMatch(plain, /Opening runtime|Executing/);
});

test('Cargo announces real parent calls lazily and labels interleaved child output', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'arsi-call-tree-'));
  const logFile = join(workspace, 'run.log');
  const terminal: string[] = [];
  const logging = configureCliLogging(true, (line) => terminal.push(line));
  t.after(() => logging.dispose());
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const start = (id: string, label: string, parentId = 'root') => {
    const fields = { callId: id, parentCallId: parentId, label };
    const activeTask = { id, label, parentId };
    runtimeLogger.debug('Running {label}', { ...fields, activeTask });
    return { ...fields, activeTask: { ...activeTask, done: true } };
  };
  await logging.run(
    { logFile },
    async () => {
      runtimeLogger.info('{label} 0.0s', {
        ...start('init', 'initialize'),
        stage: 'Completed',
      });
      const proposer = start('p', 'proposer (propose)');
      const memory = start('m', 'memoryUpdater (remember)');
      const acquire = start('q', 'acquire', 'p');
      runtimeLogger.info('{label} 0.4s', {
        ...acquire,
        stage: 'Completed',
        applicationAction: 'acquire',
        durationMs: 400,
      });
      assert.doesNotMatch(terminal.join(''), /Running proposer|acquire/);
      const agent = start('pa', 'agent', 'p');
      runtimeLogger.info('{label} 2.0s', { ...agent, stage: 'Completed' });
      const memoryAgent = start('ma', 'agent', 'm');
      runtimeLogger.info('{label} 1.0s', {
        ...memoryAgent,
        stage: 'Completed',
      });
      const commit = start('pc', 'application.commit', 'p');
      runtimeLogger.info('{label} 0.1s', { ...commit, stage: 'Completed' });
      const release = start('mr', 'release', 'm');
      runtimeLogger.info('{label} 0.5s', {
        ...release,
        stage: 'Completed',
        applicationAction: 'release',
        durationMs: 500,
      });
      runtimeLogger.info('{label} 2.2s', { ...proposer, stage: 'Completed' });
      runtimeLogger.info('{label} 1.5s', { ...memory, stage: 'Completed' });
    },
    { command: 'run' },
  );
  const output = stripVTControlCharacters(terminal.join(''));
  assert.match(
    output,
    /Completed initialize 0\.0s\n[^\n]*Running proposer \(propose\)\n {11}├─ agent 2\.0s/,
  );
  assert.match(
    output,
    /Running memoryUpdater \(remember\)\n {11}├─ agent 1\.0s\n {11}proposer \(propose\)\n {11}├─ application\.commit 0\.1s\n {11}memoryUpdater \(remember\)\n {11}├─ release 0\.5s/,
  );
  assert.match(
    output,
    /Completed proposer \(propose\) 2\.2s\n Completed memoryUpdater/,
  );
  assert.doesNotMatch(output, /Running initialize|acquire/);
  assert.match(await readFile(logFile, 'utf8'), /Completed acquire 0\.4s/);

  terminal.length = 0;
  await logging.run(
    { quiet: true, noLogFile: true },
    async () => {
      start('eval', 'evaluator (validate)');
      const release = start('bad-release', 'release', 'eval');
      runtimeLogger.error('{label} 0.1s', {
        ...release,
        stage: 'Failed',
        error: 'Cleanup failed',
      });
    },
    { command: 'run' },
  );
  assert.match(
    terminal.join(''),
    /Failed evaluator \(validate\) → release 0\.1s\n\s*Cleanup failed/,
  );
  assert.doesNotMatch(terminal.join(''), /Running evaluator/);
});
