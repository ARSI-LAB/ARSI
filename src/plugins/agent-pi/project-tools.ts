import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type BashOperations,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

function projectBash(
  root: string,
  writable: readonly string[],
): BashOperations {
  const shell = createLocalBashOperations({ shellPath: '/bin/bash' });
  return {
    async exec(command, cwd, options) {
      let args: string[];
      if (process.platform === 'darwin') {
        const subpath = (path: string): string =>
          `(subpath ${JSON.stringify(path)})`;
        const profile = [
          '(version 1) (deny default) (import "dyld-support.sb")',
          '(allow process-exec process-fork sysctl-read)',
          `(allow file-read* ${[root, '/System', '/usr', '/bin', '/sbin', '/Library/Apple/System'].map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/urandom"))`,
          `(allow file-write* ${writable.map(subpath).join(' ')} (literal "/dev/null"))`,
        ].join('\n');
        args = ['/usr/bin/sandbox-exec', '-p', profile];
      } else if (process.platform === 'linux') {
        args = [
          'bwrap',
          '--unshare-all',
          '--die-with-parent',
          '--new-session',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
        ];
        for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
          args.push('--ro-bind-try', directory, directory);
        }
        args.push('--ro-bind', root, root);
        for (const directory of writable)
          args.push('--bind', directory, directory);
        args.push('--chdir', cwd, '--');
      } else {
        throw new Error(
          'The Pi workspace bash tool requires macOS sandbox-exec or Linux bubblewrap',
        );
      }
      args.push('/bin/bash', '--noprofile', '--norc', '-c', command);
      return shell.exec(`exec ${args.map(shellQuote).join(' ')}`, cwd, {
        ...options,
        timeout: options.timeout ?? 60,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'C' },
      });
    },
  };
}

export async function projectTools(
  root: string,
  readOnly: boolean,
  bashMode: 'sandbox' | 'direct' = 'sandbox',
): Promise<ToolDefinition[]> {
  const writable = readOnly ? [] : ['candidate', 'scratch'];
  const checked = async (path: string, write = false): Promise<string> => {
    const local = relative(root, resolve(root, path));
    const parts = local.split(sep);
    if (
      isAbsolute(local) ||
      parts[0] === '..' ||
      (write && !writable.includes(parts[0]!))
    )
      throw new Error(
        `Path is outside the ${write ? 'writable' : 'authorized'} project: ${path}`,
      );
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      const info = await lstat(current).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
      if (info && !info.isDirectory() && !info.isFile())
        throw new Error(
          `Project path is not a regular file or directory: ${path}`,
        );
    }
    return current;
  };
  for (const name of writable)
    await mkdir(await checked(name, true), { recursive: true });
  const read = {
    access: async (path: string): Promise<void> => access(await checked(path)),
    readFile: async (path: string): Promise<Buffer> =>
      readFile(await checked(path)),
  };
  const write = {
    writeFile: async (path: string, content: string): Promise<void> =>
      writeFile(await checked(path, true), content),
    mkdir: async (path: string): Promise<void> => {
      await mkdir(await checked(path, true), { recursive: true });
    },
  };
  return [
    defineTool(createReadToolDefinition(root, { operations: read })),
    defineTool(
      createBashToolDefinition(root, {
        operations:
          bashMode === 'direct'
            ? createLocalBashOperations()
            : projectBash(
                root,
                writable.map((path) => join(root, path)),
              ),
        exposeSessionEnvironment: false,
      }),
    ),
    defineTool(
      createEditToolDefinition(root, {
        operations: { ...read, writeFile: write.writeFile },
      }),
    ),
    defineTool(createWriteToolDefinition(root, { operations: write })),
  ];
}
