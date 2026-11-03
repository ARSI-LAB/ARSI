import { mkdir, writeFile, realpath } from 'node:fs/promises';
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
  FileTreeFile as TreeFile,
  JsonSchema,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { inside, safeId } from '../storage/index.js';
import {
  configPathFields,
  type ConfigPathField,
} from '../../shared/config-paths.js';
export { configPathFields as resourceFields } from '../../shared/config-paths.js';
export type { FileTreeFile as TreeFile } from '../../contracts/index.js';
export interface Mapping extends JsonObject {
  kind: string;
  binding: string;
  pointer: string;
  changes: JsonValue[];
  maxBytes: number;
}
/** Match a selected field and the configured Schema paths beneath collections. */
export function selectedResourceFields(
  schema: JsonSchema,
  config: JsonObject,
  names: readonly string[],
): ConfigPathField[] {
  const fields = configPathFields(schema, config);
  const selected = new Map<string, ConfigPathField>();
  for (const name of names) {
    const pointer = '/' + name.replaceAll('~', '~0').replaceAll('/', '~1');
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
      if (pathContains(a.path, b.path) || pathContains(b.path, a.path))
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
export function count(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return n;
}
export function segments(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error('Expected JSON Pointer');
  const parts = pointer
    .slice(1)
    .split('/')
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (const part of parts)
    if (
      !/^(?:[A-Za-z][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/.test(part) ||
      ['constructor', 'prototype', '__proto__'].includes(part)
    )
      throw new Error('Unsafe configuration pointer');
  return parts;
}
export function pointerValue(value: JsonObject, pointer: string): JsonValue {
  let result: JsonValue = value;
  for (const key of segments(pointer)) {
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
export function assignPointer(
  value: JsonObject,
  pointer: string,
  entry: JsonValue,
): void {
  const parts = segments(pointer),
    last = parts.pop()!;
  let result: JsonValue = value;
  if (parts.length) result = pointerValue(value, '/' + parts.join('/'));
  if (Array.isArray(result)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(last) || Number(last) >= result.length)
      throw new Error(`Configuration pointer missing ${pointer}`);
    result[Number(last)] = entry;
  } else object(result)[last] = entry;
}
export function parseFiles(value: JsonValue): Map<string, TreeFile> {
  return new Map(parseFileTree(value).files.map((file) => [file.path, file]));
}
export async function putFile(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  const destination = inside(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o644 });
}
export function text(file: TreeFile): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(file.base64, 'base64'),
  );
}
export function resourcePath(binding: string, pointer: string): string {
  return `bindings/${safeId(binding)}/resources/${segments(pointer).join('/')}`;
}
