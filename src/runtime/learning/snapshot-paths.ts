import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { findPackageJSON } from 'node:module';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalDestinationPath, pathContains } from './resources.js';
const manifest = findPackageJSON(import.meta.url);
if (!manifest) throw new Error('Missing RSI package manifest');
const packageRoot = dirname(realpathSync.native(manifest));
export const protectedNames = new Set(['.rsi', '.git', 'dist', 'node_modules']);
export function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function stat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
export function validName(name: string): boolean {
  return (
    !!name &&
    name !== '.' &&
    name !== '..' &&
    !/[<>:"|?*\x00-\x1f\\]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(
      name,
    )
  );
}
export function validateSnapshotEntry(path: string, destination = true): void {
  if (
    isAbsolute(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !validName(part) ||
          (destination && protectedNames.has(part.toLowerCase())),
      )
  )
    throw new Error(`Unsafe resource entry ${path}`);
}
/** lstat every existing component so neither junctions nor symbolic links are followed. */
export async function inspectPath(
  path: string,
  replacingFileAncestor = false,
): Promise<void> {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let cursor = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    if (!validName(component))
      throw new Error(`Unsafe destination name ${component}`);
    cursor = join(cursor, component);
    const entry = await stat(cursor);
    if (!entry) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Linked destination rejected: ${cursor}`);
    if (cursor !== absolute && !entry.isDirectory()) {
      if (replacingFileAncestor && entry.isFile()) return;
      throw new Error(`Destination ancestor is not a directory: ${cursor}`);
    }
    if (!entry.isFile() && !entry.isDirectory())
      throw new Error(`Special destination rejected: ${cursor}`);
  }
}
export async function validateSnapshotDestination(
  destination: string,
  kind: 'file' | 'directory',
  rootDirectory: string,
  runtimeDirectory?: string,
): Promise<void> {
  const path = resolve(destination);
  await inspectPath(path);
  const physicalPath = await canonicalDestinationPath(path),
    parts = physicalPath.split(/[\\/]/).map((part) => part.toLowerCase());
  const protectedTrees = await Promise.all(
    [
      ...(runtimeDirectory ? [runtimeDirectory] : []),
      join(packageRoot, 'src', 'policies'),
      join(packageRoot, 'src', 'plugins'),
    ].map(canonicalDestinationPath),
  );
  if (
    parts.some((part) => protectedNames.has(part)) ||
    protectedTrees.some(
      (root) =>
        pathContains(root, physicalPath) ||
        (kind === 'directory' && pathContains(physicalPath, root)),
    )
  )
    throw new Error(
      `Protected destination ${path}. Export to a dedicated directory with --to <directory>`,
    );
  const projectRoots = await Promise.all(
    [rootDirectory, packageRoot].map(canonicalDestinationPath),
  );
  if (
    path === parse(path).root ||
    (kind === 'directory' &&
      projectRoots.some((root) => pathContains(physicalPath, root)))
  )
    throw new Error(
      `Whole project or filesystem root is not a dedicated resource: ${path}`,
    );
  const existing = await stat(path);
  if (
    existing &&
    (kind === 'file' ? !existing.isFile() : !existing.isDirectory())
  )
    throw new Error(`Destination kind differs from saved ${kind}: ${path}`);
  if (
    kind === 'directory' &&
    ((await stat(join(path, '.git'))) ||
      (await stat(join(path, 'package.json'))))
  )
    throw new Error(`Project directory is not a dedicated resource: ${path}`);
}
