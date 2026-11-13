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
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type {
  JsonObject,
  JsonValue,
  RuntimeContext,
} from '../../../../contracts/index.js';
import { digest, object, string } from '../../../../shared/json.js';
import type { GymBundlePublication, GymPublisher } from '../schema.js';
import { atomicWrite, inside, missing, yamlArray } from './shared.js';

type DshUserLayerPublisher = Extract<GymPublisher, { kind: 'dsh-user-layer' }>;

/** DSH-specific publisher. The Gym evaluator/release core never imports it directly. */
export async function publishDshUserLayer(
  publisher: DshUserLayerPublisher,
  context: RuntimeContext,
  publication: GymBundlePublication,
): Promise<void> {
  const home = resolve(context.rootDirectory, publisher.dshHome);
  const profileName = publisher.profileName ?? 'headless';
  const basePatch =
    publisher.basePatch === undefined
      ? undefined
      : resolve(context.rootDirectory, publisher.basePatch);
  const key = digest({
    candidateRef: publication.candidateRef,
    bundleDigest: publication.bundleDigest,
  }).slice(0, 32);
  const materialized = join(home, 'materialized', key);
  await copyOnce(publication.directory, materialized);
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
  await atomicWrite(
    join(profile, '.rsi-gym-activation.json'),
    `${JSON.stringify(
      {
        candidate_id: publication.candidateRef,
        candidate_digest: publication.bundleDigest,
        ...(publication.bundleKind === undefined
          ? {}
          : { bundle_kind: publication.bundleKind }),
      },
      null,
      2,
    )}\n`,
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
