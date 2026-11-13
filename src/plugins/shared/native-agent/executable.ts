import { access, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { executablePath } from '../doctor/executable.js';

/** Resolve native binaries and npm's Node launchers without invoking a shell. */
export async function nativeAgentCommand(
  executable: string,
): Promise<{ command: string; args: string[] }> {
  if (['.js', '.cjs', '.mjs'].includes(extname(executable).toLowerCase()))
    return { command: process.execPath, args: [resolve(executable)] };
  const path = await executablePath(executable, process.cwd());
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(path))
    return { command: path, args: [] };
  const launcher = await readFile(path, 'utf8');
  const match = /"%dp0%[\\/]([^"\r\n]+\.(?:cjs|mjs|js|exe))"/i.exec(launcher);
  if (!match)
    throw new Error(
      'Unsupported Windows CLI launcher; configure a native executable or JavaScript entrypoint.',
    );
  const entrypoint = resolve(dirname(path), match[1]);
  await access(entrypoint);
  return /\.exe$/i.test(entrypoint)
    ? { command: entrypoint, args: [] }
    : { command: process.execPath, args: [entrypoint] };
}
