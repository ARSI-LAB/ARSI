import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, matchesGlob, posix } from 'node:path';
import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { object, string, strings, unknownKeys } from '../../../shared/json.js';

export interface TreeFile {
  content: string;
  mode: number;
}
export type FileTree = Record<string, TreeFile>;
type Change = 'create' | 'modify' | 'delete';
export interface TargetEntry {
  path: string;
  kind: 'file' | 'directory';
  description: string;
  changes: Change[];
  include: string[];
  minBytes: number;
  maxBytes: number;
}
export interface Target {
  id: string;
  entries: TargetEntry[];
  protected: string[];
  maxChangedFiles: number;
  maxChangedBytes: number;
}
export interface ChangedFile {
  path: string;
  change: Change;
  before: string | null;
  after: string | null;
}

export function safePath(value: unknown): string {
  const path = string(value, 'path');
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    posix.normalize(path) !== path ||
    path === '.'
  )
    throw new Error(`path must be normalized and relative: ${path}`);
  return path;
}
function integer(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`${label}: expected non-negative integer`);
  return n;
}
export function parseTarget(value: unknown): Target {
  const raw = object(value, 'target');
  unknownKeys(
    raw,
    [
      'schemaVersion',
      'id',
      'description',
      'entries',
      'protected',
      'constraints',
    ],
    'target',
  );
  if (raw.schemaVersion !== 'rsi.target/v1')
    throw new Error('target.schemaVersion must be rsi.target/v1');
  if (!Array.isArray(raw.entries) || !raw.entries.length)
    throw new Error('target.entries must not be empty');
  const entries = raw.entries.map((item): TargetEntry => {
    const entry = object(item, 'target.entries');
    unknownKeys(
      entry,
      ['path', 'kind', 'description', 'changes', 'include', 'content'],
      'target.entry',
    );
    if (entry.kind !== 'file' && entry.kind !== 'directory')
      throw new Error('target.entry.kind must be file or directory');
    const changes = strings(entry.changes, 'target.entry.changes');
    if (
      !changes.length ||
      new Set(changes).size !== changes.length ||
      changes.some((c) => !['create', 'modify', 'delete'].includes(c))
    )
      throw new Error('target.entry.changes is invalid');
    const content = entry.content === undefined ? {} : object(entry.content);
    unknownKeys(
      content,
      ['encoding', 'minBytes', 'maxBytes'],
      'target.content',
    );
    if (content.encoding !== undefined && content.encoding !== 'utf-8')
      throw new Error('target.content.encoding must be utf-8');
    const minBytes = integer(content.minBytes, 0, 'minBytes'),
      maxBytes = integer(content.maxBytes, 1048576, 'maxBytes');
    if (minBytes > maxBytes) throw new Error('minBytes exceeds maxBytes');
    return {
      path: safePath(entry.path),
      kind: entry.kind,
      description: string(entry.description, 'target.entry.description'),
      changes: changes as Change[],
      include: entry.include === undefined ? ['**/*'] : strings(entry.include),
      minBytes,
      maxBytes,
    };
  });
  if (new Set(entries.map((e) => e.path)).size !== entries.length)
    throw new Error('target.entries contains duplicate paths');
  const constraints =
    raw.constraints === undefined ? {} : object(raw.constraints);
  unknownKeys(
    constraints,
    ['maxChangedFiles', 'maxChangedBytes'],
    'target.constraints',
  );
  return {
    id: string(raw.id, 'target.id'),
    entries,
    protected: raw.protected === undefined ? [] : strings(raw.protected),
    maxChangedFiles: integer(
      constraints.maxChangedFiles,
      32,
      'maxChangedFiles',
    ),
    maxChangedBytes: integer(
      constraints.maxChangedBytes,
      1048576,
      'maxChangedBytes',
    ),
  };
}
export async function scanTree(directory: string): Promise<FileTree> {
  const files: FileTree = {};
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      safePath(path);
      const absolute = join(directory, path),
        stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`symbolic links are not allowed: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile())
        files[path] = {
          content: (await readFile(absolute)).toString('base64'),
          mode: stat.mode & 0o777,
        };
      else throw new Error(`special file is not allowed: ${path}`);
    }
  }
  await visit('');
  return files;
}
export function checkTarget(
  before: FileTree,
  after: FileTree,
  target: Target,
  constraints: JsonObject = {},
): ChangedFile[] {
  unknownKeys(
    constraints,
    [
      'allowedPaths',
      'maxChangedFiles',
      'maxChangedBytes',
      'maxChangedSubtrees',
    ],
    'editConstraints',
  );
  const allowed =
    constraints.allowedPaths === undefined
      ? null
      : strings(constraints.allowedPaths);
  const changes: ChangedFile[] = [];
  let bytes = 0;
  const roots = new Set<string>();
  for (const path of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const previous = before[path],
      next = after[path];
    if (previous?.content === next?.content && previous?.mode === next?.mode)
      continue;
    const change: Change =
      previous === undefined
        ? 'create'
        : next === undefined
          ? 'delete'
          : 'modify';
    if (target.protected.some((pattern) => matchesGlob(path, pattern)))
      throw new Error(`protected path: ${path}`);
    const entry = target.entries.find((e) =>
      e.kind === 'file'
        ? e.path === path
        : path.startsWith(`${e.path}/`) &&
          e.include.some((pattern) =>
            matchesGlob(path.slice(e.path.length + 1), pattern),
          ),
    );
    if (!entry || !entry.changes.includes(change))
      throw new Error(`change is not authorized: ${change} ${path}`);
    if (allowed && !allowed.some((pattern) => matchesGlob(path, pattern)))
      throw new Error(`editConstraints does not authorize ${path}`);
    if (next) {
      const content = Buffer.from(next.content, 'base64');
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      if (content.length < entry.minBytes || content.length > entry.maxBytes)
        throw new Error(`content size outside bounds: ${path}`);
      bytes += content.length;
    } else bytes += Buffer.from(previous.content, 'base64').length;
    roots.add(entry.path);
    changes.push({
      path,
      change,
      before: previous?.content ?? null,
      after: next?.content ?? null,
    });
  }
  if (
    changes.length >
    Math.min(
      target.maxChangedFiles,
      integer(
        constraints.maxChangedFiles,
        target.maxChangedFiles,
        'maxChangedFiles',
      ),
    )
  )
    throw new Error('maxChangedFiles exceeded');
  if (
    bytes >
    Math.min(
      target.maxChangedBytes,
      integer(
        constraints.maxChangedBytes,
        target.maxChangedBytes,
        'maxChangedBytes',
      ),
    )
  )
    throw new Error('maxChangedBytes exceeded');
  if (
    roots.size >
    integer(
      constraints.maxChangedSubtrees,
      target.entries.length,
      'maxChangedSubtrees',
    )
  )
    throw new Error('maxChangedSubtrees exceeded');
  return changes;
}
