import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../contracts/index.js';
import { digest, json, object, string } from '../../shared/json.js';
import { scanTree } from '../shared/file-application/target.js';
import type { GymActivation } from './schema.js';

const USER_LAYER_LOCK = new Map<string, Promise<unknown>>();

/**
 * Gym's evaluation contract carries candidate identity but no candidate path.
 * The adapter therefore reads a fixed activation surface, which this function
 * updates before submission.
 */
export async function activateCandidate(
  activation: GymActivation | undefined,
  context: RuntimeContext,
  candidateRef: string,
  directory: string,
  bundleDigest: string,
): Promise<void> {
  if (activation === undefined) return;
  await assertPlainTree(directory);
  switch (activation.kind) {
    case 'directory': {
      const target = resolve(context.rootDirectory, activation.directory);
      assertDisjoint(directory, target);
      await serialized(target, () => replaceDirectory(directory, target));
      return;
    }
    case 'dsh-user-layer': {
      const home = resolve(context.rootDirectory, activation.dshHome);
      await serialized(join(home, activation.profileName ?? 'headless'), () =>
        replaceDshUserLayer(
          directory,
          home,
          activation.profileName ?? 'headless',
          activation.basePatch === undefined
            ? undefined
            : resolve(context.rootDirectory, activation.basePatch),
          candidateRef,
          bundleDigest,
        ),
      );
      return;
    }
    case 'remote-http': {
      await activateRemote(
        activation.activateUrl,
        activation.tokenEnv,
        context.signal,
        candidateRef,
        directory,
        bundleDigest,
      );
      return;
    }
  }
}

async function activateRemote(
  activateUrl: string,
  tokenEnv: string | undefined,
  signal: AbortSignal,
  candidateRef: string,
  directory: string,
  bundleDigest: string,
): Promise<void> {
  const token = tokenEnv === undefined ? undefined : process.env[tokenEnv];
  if (tokenEnv !== undefined && !token)
    throw new Error(
      `activation token environment variable ${tokenEnv} is unset`,
    );
  const response = await fetch(activateUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      candidate_id: candidateRef,
      bundle_dir: directory,
      candidate_digest: bundleDigest,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `candidate activation failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  let value: JsonObject;
  try {
    value = object(JSON.parse(text), 'activation response');
  } catch (error) {
    throw new Error(
      `candidate activation returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    value.ready !== true ||
    value.candidate_id !== candidateRef ||
    value.candidate_digest !== bundleDigest
  )
    throw new Error(
      'candidate activation did not confirm the requested candidate digest',
    );
}

async function replaceDshUserLayer(
  source: string,
  home: string,
  profileName: string,
  basePatch: string | undefined,
  candidateRef: string,
  bundleDigest: string,
): Promise<void> {
  const key = digest({ candidateRef, bundleDigest }).slice(0, 32);
  const materialized = join(home, 'materialized', key);
  await copyOnce(source, materialized);
  const bundle = await readBundle(materialized);
  const modules = join(materialized, 'node_modules');
  await rm(modules, { recursive: true, force: true });
  await mkdir(modules, { recursive: true });
  await linkDirectoryEntries(
    join(home, 'profiles', profileName, 'node_modules'),
    modules,
  );
  for (const plugin of bundle.plugins) {
    const name = await packageName(plugin);
    if (name !== null)
      await linkPackage(plugin, join(modules, ...name.split('/')));
  }
  const profile = join(home, 'profiles', profileName);
  await mkdir(profile, { recursive: true });
  const base =
    basePatch === undefined
      ? []
      : await yamlArray(await readFile(basePatch, 'utf8'), basePatch);
  await atomicWrite(
    join(profile, 'cordis.patch.yml'),
    `${JSON.stringify([...base, ...bundle.patch], null, 2)}\n`,
  );
}

interface BundleView {
  patch: JsonValue[];
  plugins: string[];
}

async function readBundle(root: string): Promise<BundleView> {
  const rootPatch = join(root, 'cordis.patch.yml');
  try {
    return {
      patch: await yamlArray(await readFile(rootPatch, 'utf8'), rootPatch),
      plugins: [],
    };
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const bundlePath = join(root, 'bundle.yaml');
  let raw: JsonObject;
  try {
    raw = object(parse(await readFile(bundlePath, 'utf8')), bundlePath);
  } catch (error) {
    if (missing(error)) return { patch: [], plugins: [] };
    throw error;
  }
  const pluginPaths: string[] = [];
  if (raw.plugins !== undefined) {
    if (!Array.isArray(raw.plugins))
      throw new Error(`${bundlePath}.plugins: expected array`);
    for (const value of raw.plugins) {
      const entry = object(value, `${bundlePath}.plugins[]`);
      pluginPaths.push(inside(root, string(entry.path, 'bundle plugin path')));
    }
  }
  const patch: JsonValue[] = [];
  for (const plugin of pluginPaths) {
    const path = join(plugin, 'cordis.patch.yml');
    try {
      patch.push(...(await yamlArray(await readFile(path, 'utf8'), path)));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return { patch, plugins: pluginPaths };
}

async function packageName(directory: string): Promise<string | null> {
  try {
    const manifest = object(
      JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
      'plugin package.json',
    );
    const name = string(manifest.name, 'plugin package name');
    if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name))
      throw new Error(`invalid plugin package name: ${name}`);
    return name;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function linkDirectoryEntries(
  source: string,
  destination: string,
): Promise<void> {
  const entries = await directoryEntries(source);
  for (const entry of entries) {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const nested = join(source, entry.name);
      const scope = join(destination, entry.name);
      await mkdir(scope, { recursive: true });
      for (const child of await readdir(nested, { withFileTypes: true }))
        await linkPath(join(nested, child.name), join(scope, child.name));
      continue;
    }
    await linkPath(join(source, entry.name), join(destination, entry.name));
  }
}

async function directoryEntries(source: string) {
  try {
    return await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function linkPackage(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await linkPath(source, destination);
}

async function linkPath(source: string, destination: string): Promise<void> {
  try {
    await lstat(destination);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const info = await stat(source);
  await symlink(
    resolve(source),
    destination,
    info.isDirectory()
      ? process.platform === 'win32'
        ? 'junction'
        : 'dir'
      : 'file',
  );
}

async function replaceDirectory(source: string, target: string): Promise<void> {
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

async function copyOnce(source: string, target: string): Promise<void> {
  try {
    await stat(target);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    try {
      await rename(staging, target);
    } catch (error) {
      try {
        await stat(target);
        return;
      } catch (missingTarget) {
        if (!missing(missingTarget)) throw error;
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function assertPlainTree(directory: string): Promise<void> {
  await scanTree(directory);
}

function assertDisjoint(source: string, target: string): void {
  for (const [left, right, label] of [
    [source, target, 'activation target inside candidate'],
    [target, source, 'candidate inside activation target'],
  ] as const) {
    const value = relative(left, right);
    if (
      value === '' ||
      (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
    )
      throw new Error(label);
  }
}

function inside(root: string, path: string): string {
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

function yamlArray(text: string, label: string): JsonValue[] {
  const value = parse(text);
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  json(value);
  return value;
}

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = USER_LAYER_LOCK.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  USER_LAYER_LOCK.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
