import { lstat, readFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
  JsonSchema,
} from '../../contracts/index.js';
import { object, string, digest } from '../../shared/json.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { pointerParent } from '../loaders/config.js';
import type { Recipe } from '../loaders/recipe.js';
import type { Registry } from '../registry/index.js';
import {
  parseLockedConfig,
  type MemoryConfig,
  type ReflectionConfig,
} from '../evolution/schema.js';
import { captureMemorySeed } from '../evolution/memory.js';
import { evolutionAgentBinding } from '../evolution/validation.js';
import { inside } from '../storage/index.js';

export const definitionLockVersion = 'rsi.definition-lock/v3';

export function definitionArchiveId(id: string, locked: JsonObject): string {
  return digest({ id, definition: locked.digest });
}

export function parseLockedMemory(value: JsonValue): MemoryConfig {
  return parseLockedConfig('memory', value);
}
export function parseLockedReflection(value: JsonValue): ReflectionConfig {
  return parseLockedConfig('reflection', value);
}

export function readResourceOrigins(
  locked: JsonObject,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(object(locked.resourceOrigins)).map(([name, paths]) => [
      name,
      Object.fromEntries(
        Object.entries(object(paths)).map(([pointer, path]) => [
          pointer,
          string(path),
        ]),
      ),
    ]),
  );
}

function resourceSnapshots(
  locked: JsonObject,
): Map<string, { directory: string; artifactRef: string }> {
  if (!Array.isArray(locked.resources))
    throw new Error('Invalid locked resources');
  return new Map(
    locked.resources.map((raw) => {
      const resource = object(raw);
      const directory = string(resource.directory);
      return [
        basename(directory),
        { directory, artifactRef: string(resource.artifactRef) },
      ];
    }),
  );
}

/** Lock definitions and owned resource copies before the first business side effect. */
export async function lockDefinition(
  recipe: Recipe,
  registry: Registry,
  artifacts: ArtifactStore,
  directory: string,
  retry?: JsonObject,
  previous?: JsonObject,
): Promise<JsonObject> {
  const declaration = recipe.toJSON();
  const resources: JsonObject[] = [];
  const plugins: JsonObject = {};
  const bindingVersions: JsonObject = {};
  const resourceOrigins: JsonObject = {};
  const previousResources = previous && resourceSnapshots(previous);
  const attemptDirectory = retry
    ? inside(directory, join(directory, string(retry.ref)))
    : directory;
  const capture = async (
    id: string,
    config: JsonObject,
    owner: string,
    schema?: JsonSchema,
    prefix = '',
  ): Promise<JsonObject> => {
    if (id) plugins[id] = registry.identity(id);
    const sourceConfig = structuredClone(config);
    const localResources: JsonObject = {};
    for (const field of configPathFields(
      schema ?? registry.get(id).configSchema,
      config,
    )) {
      const pointer = prefix + field.pointer;
      const { parent, key } = pointerParent(config, field.pointer);
      const source = string(
        Array.isArray(parent) ? parent[Number(key)] : parent[key],
      );
      const origins = object(resourceOrigins[owner] ?? {});
      origins[pointer] = source;
      resourceOrigins[owner] = origins;
      if (isResourceUrl(source)) continue;
      const info = await lstat(source);
      if (
        info.isSymbolicLink() ||
        (field.kind === 'file' ? !info.isFile() : !info.isDirectory())
      )
        throw new Error(`Invalid locked resource ${owner}${pointer}`);
      const slot = digest({ owner, pointer }).slice(0, 32);
      const artifactRef =
        field.kind === 'directory'
          ? await artifacts.capture(source)
          : await artifacts.putJson({
              kind: 'file-tree',
              files: [
                {
                  path: basename(source),
                  mode: info.mode & 0o777,
                  base64: (await readFile(source)).toString('base64'),
                },
              ],
            });
      const saved = previousResources?.get(slot);
      const target =
        saved?.artifactRef === artifactRef
          ? inside(directory, saved.directory)
          : join(attemptDirectory, slot);
      await restoreResource(artifacts, target, artifactRef);
      resources.push({ directory: target, artifactRef });
      localResources[pointer] = artifactRef;
      const lockedPath =
        field.kind === 'directory' ? target : join(target, basename(source));
      if (Array.isArray(parent)) parent[Number(key)] = lockedPath;
      else parent[key] = lockedPath;
    }
    if (id)
      bindingVersions[owner] = digest({ id, sourceConfig, localResources });
    return localResources;
  };
  await capture(
    '',
    object(object(declaration.policy).config),
    '_policy',
    recipe.policy.configSchema,
  );
  const application = object(declaration.application);
  await capture(
    string(application.plugin),
    object(application.config),
    '_application',
  );
  for (const [name, entry] of Object.entries(object(declaration.bindings))) {
    const binding = object(entry);
    await capture(string(binding.plugin), object(binding.config), name);
  }
  const evolution: JsonObject = { memory: null, reflection: null };
  const synthesized = recipe.bindings[evolutionAgentBinding];
  if (synthesized) {
    const id = synthesized.pluginId;
    await capture(
      id,
      structuredClone(synthesized.config),
      evolutionAgentBinding,
    );
    if (previous && object(previous.plugins)[id] !== plugins[id])
      throw new Error(
        'Locked runtime evolution Agent implementation changed: ' + id,
      );
  }
  for (const kind of ['memory', 'reflection'] as const) {
    const module = recipe[kind];
    if (!module) continue;
    const owner = '_' + kind;
    const data = object(structuredClone(module));
    if (previous && previous[kind]) {
      const old = object(previous[kind]);
      const pluginId = string(old.plugin);
      if (object(previous.plugins)[pluginId] !== registry.identity(pluginId))
        throw new Error(
          'Locked runtime evolution implementation changed: ' + pluginId,
        );
      plugins[pluginId] = registry.identity(pluginId);
      bindingVersions[owner] = object(previous.bindingVersions)[owner]!;
      const origins = object(object(previous.resourceOrigins)[owner] ?? {});
      resourceOrigins[owner] = origins;
      for (const pointer of Object.keys(origins)) {
        const saved = previousResources?.get(
          digest({ owner, pointer }).slice(0, 32),
        );
        if (!saved) continue;
        await restoreResource(
          artifacts,
          inside(directory, saved.directory),
          saved.artifactRef,
        );
        resources.push(saved);
      }
      evolution[kind] = old;
      continue;
    }
    await capture(
      module.plugin,
      object(data.config),
      owner,
      undefined,
      '/config',
    );
    const fields = await capture('', data, owner, {
      type: 'object',
      properties: { goalFile: { type: 'string', 'x-rsi-path': 'file' } },
    });
    if (kind === 'memory') {
      const source = recipe.memory?.seed?.directory;
      if (source) object(resourceOrigins[owner])['/directory'] = source;
      data.seedArtifactRef = await captureMemorySeed(artifacts, source);
      fields['/directory'] = data.seedArtifactRef;
    }
    data.digest = digest({
      configuration: module.digest,
      pluginResources: bindingVersions[owner],
      fields,
    });
    evolution[kind] = data;
  }
  const locked: JsonObject = {
    schemaVersion: definitionLockVersion,
    recipe: declaration,
    policy: recipe.policy.toJSON(),
    recipeSourcePath: recipe.sourcePath,
    policySourcePath: recipe.policy.sourcePath,
    plugins,
    bindingVersions,
    resources,
    resourceOrigins,
    ...evolution,
    ...(retry === undefined ? {} : { retry }),
  };
  return { ...locked, digest: digest(locked) };
}

async function restoreResource(
  artifacts: ArtifactStore,
  target: string,
  ref: string,
): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    await mkdir(dirname(target), { recursive: true });
    await artifacts.materialize(ref, target);
    return;
  }
  if ((await artifacts.capture(target)) !== ref)
    throw new Error(`Locked resource contents differ: ${target}`);
}

export function assertDefinitionLock(locked: JsonObject): void {
  if (locked.schemaVersion !== definitionLockVersion)
    throw new Error(
      `Unsupported experiment definition lock ${String(locked.schemaVersion)}. Resuming requires ${definitionLockVersion}. Start a new experiment.`,
    );
  assertDefinitionDigest(locked);
}

export function assertDefinitionDigest(locked: JsonObject): void {
  const { digest: expected, ...content } = locked;
  if (expected !== digest(content))
    throw new Error('Experiment definition lock digest mismatch');
}
