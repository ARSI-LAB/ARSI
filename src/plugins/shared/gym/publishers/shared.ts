import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { JsonValue } from '../../../../contracts/index.js';
import { json } from '../../../../shared/json.js';

export function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export function inside(root: string, path: string): string {
  const value = resolve(root, path);
  const rel = relative(root, value);
  if (
    rel === '' ||
    rel.startsWith(`..${sep}`) ||
    rel === '..' ||
    isAbsolute(rel)
  )
    throw new Error(`bundle path escapes its root: ${path}`);
  return value;
}

export function yamlArray(text: string, label: string): JsonValue[] {
  const value = parse(text);
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  json(value);
  return value;
}

export function assertDisjoint(source: string, target: string): void {
  for (const [left, right, label] of [
    [source, target, 'publish target inside candidate'],
    [target, source, 'candidate inside publish target'],
  ] as const) {
    const value = relative(left, right);
    if (
      value === '' ||
      (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
    )
      throw new Error(label);
  }
}

export async function replaceDirectory(
  source: string,
  target: string,
  prepare?: (staging: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const staging = join(parent, `.rsi-gym-slot-${nonce}`);
  const backup = join(parent, `.rsi-gym-slot-backup-${nonce}`);
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  try {
    await cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    if (prepare !== undefined) await prepare(staging);
    let moved = false;
    try {
      await rename(target, backup);
      moved = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (moved) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
