import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
await rm(join(root, 'dist'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
);
async function resources(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name),
      target = join(to, entry.name);
    if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name)) continue;
    if (entry.isDirectory()) await resources(source, target);
    else if (!/\.tsx?$/.test(entry.name)) {
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
}
await resources(join(root, 'src'), join(root, 'dist/src'));
execFileSync(
  process.execPath,
  [
    join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
    'build',
    '--config',
    'web/vite.config.ts',
  ],
  { cwd: root, stdio: 'inherit' },
);
await chmod(join(root, 'dist/src/entries/cli/main.js'), 0o755);
