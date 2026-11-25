import { realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  resolve,
  relative,
  isAbsolute,
  sep,
} from 'node:path';
import type {
  JsonObject,
  JsonValue,
  JsonSchema,
} from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import { safeId } from '../storage/index.js';
import { configPathFields, type ConfigPathField } from '../../shared/paths.js';
/** Match a selected field and the configured Schema paths beneath collections. */
export function selectedResourceFields(
  schema: JsonSchema,
  config: JsonObject,
  names: readonly string[],
): ConfigPathField[] {
  const fields = configPathFields(schema, config);
  const selected = new Map<string, ConfigPathField>();
  for (const name of names) {
    const pointer = name.startsWith('/')
      ? name
      : '/' + name.replaceAll('~', '~0').replaceAll('/', '~1');
    const matches = fields.filter(
      (field) =>
        field.pointer === pointer || field.pointer.startsWith(pointer + '/'),
    );
    if (!matches.length)
      throw new Error(
        `Resource ${name} is not declared by plugin config Schema`,
      );
    for (const field of matches) selected.set(field.pointer, field);
  }
  return [...selected.values()];
}
export interface EditableRoot {
  binding: string;
  pointer: string;
  path: string;
  kind: 'file' | 'directory';
}
export type ResourceMember = {
  binding: string;
  pointer: string;
  kind: 'file' | 'directory';
  relativePath: string;
};
export type CoveringRoot = {
  /** Original absolute path to inspect before an in-place write. */
  path: string;
  /** Original physical identity when different from the configured path. */
  physicalPath?: string;
  artifactPath: string;
  kind: 'file' | 'directory';
  members: ResourceMember[];
};
export function memberPath(root: CoveringRoot, member: ResourceMember): string {
  return member.relativePath
    ? root.artifactPath + '/' + member.relativePath
    : root.artifactPath;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function byOwner(a: ResourceMember, b: ResourceMember): number {
  return compare(a.binding, b.binding) || compare(a.pointer, b.pointer);
}
export function coveringArtifactPath(
  path: string,
  members: readonly ResourceMember[],
): string {
  const owners = members
    .filter((member) => member.relativePath === '')
    .sort(byOwner);
  if (!owners.length) throw new Error('Covering root requires a root owner');
  const owner = owners[0]!;
  if (owners.length === 1)
    return `resources/${safeId(owner.binding)}/${segments(owner.pointer).join('/')}`;
  const slug =
    basename(path)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 64) || 'resource';
  return `resources/_shared/${slug}-${digest(owners.map(({ binding, pointer }) => [binding, pointer])).slice(0, 8)}`;
}

/** Group selected source locations before projecting the isolated binding copies. */
export async function resolveCoveringRoots(
  entries: readonly EditableRoot[],
): Promise<CoveringRoot[]> {
  const physical = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      path: resolve(entry.path),
      physicalPath: await canonicalDestinationPath(entry.path),
    })),
  );
  physical.sort(
    (a, b) =>
      a.physicalPath.split(sep).length - b.physicalPath.split(sep).length ||
      compare(a.physicalPath, b.physicalPath) ||
      compare(a.path, b.path),
  );
  const roots: CoveringRoot[] = [];
  for (const { path, physicalPath, binding, pointer, kind } of physical) {
    let root = roots.find((candidate) =>
      pathContains(candidate.physicalPath ?? candidate.path, physicalPath),
    );
    if (!root) {
      root = {
        path,
        ...(physicalPath !== path ? { physicalPath } : {}),
        kind,
        members: [],
        artifactPath: '',
      };
      roots.push(root);
    }
    // All owners must describe the same subtree through the recorded writeback path.
    const local = relative(root.physicalPath ?? root.path, physicalPath);
    if (relative(resolve(root.path, local), path) !== '')
      throw new Error(
        `Inconsistent Reflection source aliases: ${root.path} and ${path}`,
      );
    root.members.push({
      binding,
      pointer,
      kind,
      relativePath: local.split(sep).join('/'),
    });
  }
  for (const root of roots) {
    root.members.sort(byOwner);
    root.artifactPath = coveringArtifactPath(root.path, root.members);
  }
  return parseCoveringRoots(roots);
}

/** Recheck saved mappings before deriving filesystem or artifact destinations. */
export function parseCoveringRoots(raw: JsonValue | undefined): CoveringRoot[] {
  if (!Array.isArray(raw)) throw new Error('Invalid Reflection sourceRoots');
  const owners = new Set<string>();
  function kind(value: JsonValue | undefined): 'file' | 'directory' {
    if (value !== 'file' && value !== 'directory')
      throw new Error('Invalid Reflection resource kind');
    return value;
  }
  const roots = raw.map((value) => {
    const data = object(value);
    const path = string(data.path);
    const physicalPath =
      data.physicalPath === undefined ? path : string(data.physicalPath);
    const rootKind = kind(data.kind);
    if (
      [path, physicalPath].some(
        (path) =>
          !isAbsolute(path) ||
          path.includes('\0') ||
          (process.platform === 'win32' && /^\\\\[?.]\\/.test(path)) ||
          resolve(path) !== path,
      ) ||
      !Array.isArray(data.members)
    )
      throw new Error('Invalid Reflection covering root');
    const members = data.members.map((value) => {
      const member = object(value);
      const binding = safeId(string(member.binding)),
        pointer = string(member.pointer);
      segments(pointer);
      const id = JSON.stringify([binding, pointer]);
      if (owners.has(id))
        throw new Error('Duplicate Reflection resource owner');
      owners.add(id);
      const relativePath = member.relativePath,
        memberKind = kind(member.kind);
      if (typeof relativePath !== 'string')
        throw new Error('Invalid Reflection member relative path');
      if (
        relativePath === ''
          ? memberKind !== rootKind
          : rootKind !== 'directory' ||
            relativePath.includes('\\') ||
            relativePath.includes('\0') ||
            relativePath
              .split('/')
              .some(
                (part) =>
                  !part ||
                  part === '.' ||
                  part === '..' ||
                  /^[A-Za-z]:/.test(part),
              )
      )
        throw new Error('Invalid Reflection resource member path or kind');
      return { binding, pointer, kind: memberKind, relativePath };
    });
    for (const member of members.filter((member) => member.kind === 'file'))
      if (
        members.some((other) =>
          other.relativePath === member.relativePath
            ? other.kind !== 'file'
            : other.relativePath.startsWith(member.relativePath + '/'),
        )
      )
        throw new Error('Conflicting Reflection file and directory resources');
    const artifactPath = string(data.artifactPath);
    const expected = coveringArtifactPath(path, members);
    // Earlier shared roots remain at their saved artifact paths throughout the revision chain.
    if (
      artifactPath !== expected &&
      artifactPath !==
        expected.replace(/^resources\/_shared\//, 'resources/shared/')
    )
      throw new Error('Invalid Reflection covering root artifact path');
    return {
      path,
      ...(physicalPath !== path ? { physicalPath } : {}),
      kind: rootKind,
      artifactPath,
      members,
    };
  });
  for (const [index, root] of roots.entries()) {
    for (const other of roots.slice(index + 1))
      if (
        pathsOverlap(root.path, other.path) ||
        pathsOverlap(
          root.physicalPath ?? root.path,
          other.physicalPath ?? other.path,
        ) ||
        pathsOverlap(root.artifactPath, other.artifactPath)
      )
        throw new Error('Overlapping Reflection covering roots');
  }
  return roots;
}
function pathsOverlap(a: string, b: string): boolean {
  return pathContains(a, b) || pathContains(b, a);
}
export function pathContains(root: string, candidate: string): boolean {
  const local = relative(resolve(root), resolve(candidate));
  return (
    local === '' ||
    (!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep))
  );
}
/** Each editable destination has one owner, including collections of one binding. */
export function validateEditableRoots(entries: readonly EditableRoot[]): void {
  for (let index = 0; index < entries.length; index++) {
    const a = entries[index]!;
    for (const b of entries.slice(index + 1)) {
      if (pathsOverlap(a.path, b.path))
        throw new Error(
          `Overlapping editable destinations ${a.binding}${a.pointer} (${resolve(a.path)}) and ${b.binding}${b.pointer} (${resolve(b.path)})`,
        );
    }
  }
}
/** Resolve existing ancestor aliases without changing the persisted destination mapping. */
export async function canonicalDestinationPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  if (process.platform === 'win32' && /^\\\\[?.]\\/.test(ancestor))
    throw new Error(
      `Windows device namespace destination aliases are not supported: ${path}`,
    );
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'ENOTDIR'].includes(String(error.code))
        ) ||
        dirname(ancestor) === ancestor
      )
        throw error;
      suffix.push(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
/** Existing Windows short names and normal paths must not create multiple write owners. */
export async function validateEditableDestinations(
  entries: readonly EditableRoot[],
): Promise<void> {
  validateEditableRoots(
    await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        path: await canonicalDestinationPath(entry.path),
      })),
    ),
  );
}
function configurationKeys(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error('Expected JSON Pointer');
  const parts = pointer
    .slice(1)
    .split('/')
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (const part of parts)
    if (['constructor', 'prototype', '__proto__'].includes(part))
      throw new Error('Unsafe configuration pointer');
  return parts;
}
/** A Schema property may contain a slash or device name. Give those keys a portable snapshot path. */
export function segments(pointer: string): string[] {
  return configurationKeys(pointer).map((key) =>
    /^(?:[A-Za-z][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/.test(key) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|dist|node_modules)$/i.test(key) &&
    key.length <= 200
      ? key
      : '@' + digest(key),
  );
}
function valueAt(
  value: JsonObject,
  keys: string[],
  pointer: string,
): JsonValue {
  let result: JsonValue = value;
  for (const key of keys) {
    if (Array.isArray(result) && !/^(?:0|[1-9][0-9]*)$/.test(key))
      throw new Error(`Configuration pointer missing ${pointer}`);
    const record: JsonObject | JsonValue[] = Array.isArray(result)
      ? result
      : object(result);
    if (!Object.hasOwn(record, key))
      throw new Error(`Configuration pointer missing ${pointer}`);
    result = Array.isArray(record) ? record[Number(key)]! : record[key]!;
  }
  return result;
}
export function pointerValue(value: JsonObject, pointer: string): JsonValue {
  return valueAt(value, configurationKeys(pointer), pointer);
}
export function assignPointer(
  value: JsonObject,
  pointer: string,
  entry: JsonValue,
): void {
  const parts = configurationKeys(pointer),
    last = parts.pop()!;
  let result: JsonValue = value;
  if (parts.length) result = valueAt(value, parts, pointer);
  if (Array.isArray(result)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(last) || Number(last) >= result.length)
      throw new Error(`Configuration pointer missing ${pointer}`);
    result[Number(last)] = entry;
  } else object(result)[last] = entry;
}
export function resourcePath(binding: string, pointer: string): string {
  return `bindings/${safeId(binding)}/resources/${segments(pointer).join('/')}`;
}
