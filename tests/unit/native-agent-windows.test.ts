import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { nativeAgentCommand } from '../../src/plugins/shared/native-agent/executable.js';
import { runCommand } from '../../src/plugins/shared/doctor/process.js';

test(
  'Windows npm launcher uses the Node entrypoint and preserves literal arguments',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native launcher '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, 'package', 'cli.js');
    await mkdir(join(root, 'package'));
    await writeFile(
      script,
      'console.log(JSON.stringify(process.argv.slice(2)));',
    );
    const shim = join(root, 'fixture.cmd');
    await writeFile(
      shim,
      '@ECHO off\r\n"node" "%dp0%\\package\\cli.js" %*\r\n',
    );
    // npm also installs an extensionless POSIX shell launcher beside the .cmd.
    await writeFile(join(root, 'fixture'), '#!/bin/sh\nexit 99\n');
    const previous = process.env.PATH;
    process.env.PATH = `${root}${delimiter}${previous ?? ''}`;
    try {
      for (const name of ['fixture', shim]) {
        const launch = await nativeAgentCommand(name);
        assert.equal(launch.command, process.execPath);
        assert.deepEqual(launch.args, [script]);
        const args = [
          'space here',
          '& echo unexpected',
          '%PATH%',
          '"quoted"',
          '中文',
        ];
        const result = await runCommand(
          launch.command,
          [...launch.args, ...args],
          { signal: AbortSignal.timeout(10000) },
        );
        assert.deepEqual(JSON.parse(result.stdout), args);
      }
      await writeFile(shim, '@ECHO off\r\necho unsupported\r\n');
      await assert.rejects(
        nativeAgentCommand(shim),
        /Unsupported Windows CLI launcher/,
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);

test(
  'Windows npm binary launcher runs the native executable without a shell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native binary launcher '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'opencode.exe');
    await copyFile(process.execPath, binary);
    const shim = join(root, 'opencode.cmd');
    await writeFile(shim, '@ECHO off\r\n"%dp0%\\opencode.exe" %*\r\n');
    const launch = await nativeAgentCommand(shim);
    assert.deepEqual(launch, { command: binary, args: [] });
    const values = ['literal & value', '%PATH%', '中文'];
    const result = await runCommand(
      launch.command,
      ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values],
      { signal: AbortSignal.timeout(10000) },
    );
    assert.deepEqual(JSON.parse(result.stdout), values);
  },
);
