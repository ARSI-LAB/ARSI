import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCommand } from '../../src/plugins/agent-codex/executable.js';

test('Codex JavaScript entrypoints use Node with a literal argument', () => {
  const script = join(process.cwd(), 'path with spaces & symbols', 'codex.cjs');
  assert.deepEqual(codexCommand(script), {
    executable: process.execPath,
    args: [script],
  });
});

test(
  'Windows resolves npm global/local Codex shims without a shell',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex path & spaces-'));
    const previous = process.env.PATH;
    try {
      for (const local of [false, true]) {
        const prefix = join(directory, local ? 'local' : 'global');
        const bin = local ? join(prefix, 'node_modules', '.bin') : prefix;
        const root = join(prefix, 'node_modules', '@openai', 'codex');
        const native = join(
          root,
          'vendor',
          process.arch === 'arm64'
            ? 'aarch64-pc-windows-msvc'
            : 'x86_64-pc-windows-msvc',
          'bin',
          'codex.exe',
        );
        await mkdir(bin, { recursive: true });
        await mkdir(join(native, '..'), { recursive: true });
        await writeFile(join(root, 'package.json'), '{}');
        await writeFile(
          join(bin, 'codex.cmd'),
          '@echo this batch file must not run',
        );
        await writeFile(native, '');
        process.env.PATH = bin;
        assert.deepEqual(codexCommand('codex'), {
          executable: native,
          args: [],
        });
        assert.deepEqual(codexCommand(join(bin, 'codex.cmd')), {
          executable: native,
          args: [],
        });
      }
      const native = join(directory, 'codex.exe');
      await writeFile(native, '');
      process.env.PATH = directory;
      assert.deepEqual(codexCommand('codex'), { executable: native, args: [] });
      await rm(native);
      await writeFile(join(directory, 'codex.cmd'), '');
      assert.throws(
        () => codexCommand('codex'),
        /Cannot resolve npm Codex shim/,
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'relative native Codex paths resolve before switching the child working directory',
  { skip: process.platform === 'win32' },
  () => {
    assert.deepEqual(codexCommand('./bin/codex'), {
      executable: join(process.cwd(), 'bin/codex'),
      args: [],
    });
    assert.deepEqual(codexCommand('codex'), { executable: 'codex', args: [] });
  },
);
