import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Registry } from '../registry/index.js';

/** Explicit startup modules register capabilities; Recipe refs never import code. */
export async function loadPluginDirectories(
  registry: Registry,
  directories: readonly string[],
): Promise<void> {
  const loaded = new Set<string>();
  for (const directory of directories) {
    const absolute = resolve(directory);
    try {
      const canonical = await realpath(absolute);
      if (loaded.has(canonical)) continue;
      const module: unknown = await import(
        pathToFileURL(join(canonical, 'index.mjs')).href
      );
      if (
        !module ||
        typeof module !== 'object' ||
        !('register' in module) ||
        typeof module.register !== 'function'
      ) {
        throw new Error('index.mjs must export a register(registry) function');
      }
      await module.register(registry);
      loaded.add(canonical);
    } catch (cause) {
      throw new Error(`Failed to load plugin directory ${absolute}`, { cause });
    }
  }
}

/** Only immediate extension folders are loaded; a missing home is allowed. */
export async function homePluginDirectories(
  homeDirectory = join(homedir(), '.ember-rsi'),
): Promise<string[]> {
  const directory = join(homeDirectory, 'plugins');
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
}
