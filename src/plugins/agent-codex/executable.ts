import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

/** Resolve npm shims to the native CLI, preserving shell-free execution and cancellation. */
export function codexCommand(executable: string): {
  executable: string;
  args: string[];
} {
  if (['.js', '.cjs', '.mjs'].includes(extname(executable)))
    return { executable: process.execPath, args: [resolve(executable)] };
  if (process.platform !== 'win32') return { executable, args: [] };
  const candidates = /[/\\]/.test(executable)
    ? [resolve(executable)]
    : (process.env.PATH ?? '').split(';').flatMap((directory) => {
        if (!directory) return [];
        return extname(executable)
          ? [join(directory, executable)]
          : [
              join(directory, `${executable}.exe`),
              join(directory, `${executable}.cmd`),
            ];
      });
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (extname(candidate).toLowerCase() !== '.cmd')
      return { executable: candidate, args: [] };
    // npm global and local .bin layouts; do not execute or interpret a batch file.
    for (const packageRoot of [
      join(dirname(candidate), 'node_modules', '@openai', 'codex'),
      join(dirname(candidate), '..', '@openai', 'codex'),
    ]) {
      if (!existsSync(join(packageRoot, 'package.json'))) continue;
      const target =
        process.arch === 'arm64'
          ? 'aarch64-pc-windows-msvc'
          : 'x86_64-pc-windows-msvc';
      let vendor = join(packageRoot, 'vendor');
      try {
        const require = createRequire(join(packageRoot, 'package.json'));
        vendor = join(
          dirname(
            require.resolve(`@openai/codex-win32-${process.arch}/package.json`),
          ),
          'vendor',
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'MODULE_NOT_FOUND'
          )
        )
          throw error;
      }
      for (const layout of ['bin', 'codex']) {
        const native = join(vendor, target, layout, 'codex.exe');
        if (existsSync(native)) return { executable: native, args: [] };
      }
    }
    throw new Error(
      'Cannot resolve npm Codex shim; install its Windows optional dependency or configure executable with a native codex.exe path',
    );
  }
  return { executable, args: [] };
}
