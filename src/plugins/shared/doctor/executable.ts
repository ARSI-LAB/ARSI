import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

/** Resolve the same command search path used by a shell-free child process. */
export async function executablePath(
  command: string,
  cwd: string,
): Promise<string> {
  const explicit = isAbsolute(command) || /[/\\]/.test(command);
  const extensions =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : (process.env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';')
      : [''];
  const bases = explicit
    ? [resolve(cwd, command)]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((entry) => join(entry || cwd, command));
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = base + extension;
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(
          candidate,
          process.platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'EACCES')
          )
        )
          throw error;
      }
    }
  }
  throw new Error(
    `ENOENT: Executable is unavailable in the launch environment: ${command}`,
  );
}
