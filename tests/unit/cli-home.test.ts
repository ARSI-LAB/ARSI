import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('CLI creates its extension home on first launch and preserves existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-home-'));
  const home = join(root, 'home');
  const plugins = join(home, '.ember-rsi', 'plugins');
  const launch = async (...args: string[]): Promise<void> => {
    await execute(
      process.execPath,
      ['--import', 'tsx', resolve('src/entries/cli/main.ts'), ...args],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 30000,
      },
    );
  };
  try {
    await launch();
    assert.ok((await stat(plugins)).isDirectory());
    const marker = join(plugins, 'existing.txt');
    await writeFile(marker, 'preserve me');
    await launch('--help');
    assert.equal(await readFile(marker, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI reports an error when its home path is occupied by a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-home-'));
  const blocked = join(root, '.ember-rsi');
  try {
    await writeFile(blocked, 'preserve me');
    await assert.rejects(
      execute(
        process.execPath,
        ['--import', 'tsx', resolve('src/entries/cli/main.ts'), '--help'],
        {
          env: { ...process.env, HOME: root, USERPROFILE: root },
          timeout: 30000,
        },
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && 'code' in error && 'stderr' in error,
        );
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /ENOTDIR|EEXIST/);
        return true;
      },
    );
    assert.equal(await readFile(blocked, 'utf8'), 'preserve me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
