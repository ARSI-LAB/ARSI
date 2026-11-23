import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonicalDestinationPath } from './resources.js';

/** Check filesystem names under the resource gate, with no active experiment owners. */
export async function validateDestinationNames(
  paths: readonly string[],
): Promise<void> {
  const physical = await Promise.all(paths.map(canonicalDestinationPath));
  for (let index = 0; index < physical.length; index++) {
    const path = physical[index]!;
    for (const other of physical.slice(index + 1)) {
      if (
        path === other ||
        path.startsWith(other + sep) ||
        other.startsWith(path + sep)
      )
        throw new Error(
          `Snapshot destination alias or file ancestor collision: ${path} and ${other}`,
        );
    }
  }
  const groups = new Map<string, { target: string; suffix: string[] }[]>();
  for (const target of physical) {
    let ancestor = dirname(target);
    const suffix = [basename(target)];
    for (;;) {
      const entry = await lstat(ancestor).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'ENOTDIR'].includes(String(error.code))
        )
          return undefined;
        throw error;
      });
      if (entry?.isDirectory()) break;
      if (dirname(ancestor) === ancestor)
        throw new Error(
          `Destination filesystem root is unavailable: ${target}`,
        );
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    const directory = await realpath(ancestor);
    const group = groups.get(directory) ?? [];
    group.push({ target, suffix });
    groups.set(directory, group);
  }
  for (const [directory, group] of groups) {
    if (group.length < 2) continue;
    // Empty temporary entries let the target filesystem compare the exact names,
    // including case and Unicode aliases. OS names or lowercasing cannot do that.
    // New directories inherit this ancestor's rules; existing directories have
    // their own groups so mounted volumes and per-directory rules are respected.
    const probe = await mkdtemp(join(directory, '.rsi-name-check-'));
    try {
      for (const { target, suffix } of group) {
        const path = resolve(probe, ...suffix);
        try {
          await mkdir(dirname(path), { recursive: true });
          const handle = await open(path, 'wx');
          await handle.close();
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            ['EEXIST', 'ENOTDIR', 'EISDIR'].includes(String(error.code))
          )
            throw new Error(
              `Snapshot destination alias or file ancestor collision: ${target}`,
              { cause: error },
            );
          throw error;
        }
      }
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}
