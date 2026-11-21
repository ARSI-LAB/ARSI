import { lstat, readFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
  JsonSchema,
} from '../../contracts/index.js';
import { object, string, strings, digest } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import type { Recipe } from '../loaders/recipe.js';
import type { Registry } from '../registry/index.js';
import type { ReflectionConfig } from '../revisions/validation.js';
import { inside } from '../storage/index.js';

export const definitionLockVersion = 'rsi.definition-lock/v2';

export function definitionArchiveId(id: string, locked: JsonObject): string {
  return digest({ id, definition: locked.digest });
}

/** Validate persisted Reflection data without consulting mutable source files. */
export function parseLockedReflection(value: JsonValue): ReflectionConfig {
  const data = object(value, 'locked Reflection');
  validate(
    {
      type: 'object',
      required: [
        'path',
        'digest',
        'evidence',
        'targets',
        'goal',
        'implementation',
        'budget',
      ],
      properties: {
        path: { type: 'string' },
        digest: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        targets: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['resources'],
            properties: {
              resources: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        goal: { type: 'string' },
        implementation: {
          type: 'object',
          required: ['contract', 'ref', 'config'],
          properties: {
            contract: { const: 'contract.reflection' },
            ref: { type: 'string' },
            config: { type: 'object' },
          },
          additionalProperties: false,
        },
        budget: {
          type: 'object',
          properties: {
            modelCalls: { type: 'integer', minimum: 0 },
            elapsedWallMs: { type: 'integer', minimum: 1 },
            evidenceBytes: {
              type: 'integer',
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    data,
    'locked Reflection',
  );
  const implementation = object(data.implementation);
  const budget = object(data.budget);
  return {
    path: string(data.path),
    digest: string(data.digest),
    evidence: strings(data.evidence),
    goal: string(data.goal),
    targets: Object.fromEntries(
      Object.entries(object(data.targets)).map(([name, target]) => [
        name,
        { resources: strings(object(target).resources) },
      ]),
    ),
    implementation: {
      contract: string(implementation.contract),
      ref: string(implementation.ref),
      config: object(implementation.config),
    },
    budget: {
      ...(budget.modelCalls === undefined
        ? {}
        : { modelCalls: Number(budget.modelCalls) }),
      ...(budget.elapsedWallMs === undefined
        ? {}
        : { elapsedWallMs: Number(budget.elapsedWallMs) }),
      ...(budget.evidenceBytes === undefined
        ? {}
        : { evidenceBytes: Number(budget.evidenceBytes) }),
    },
  };
}

function pointerParent(
  value: JsonObject,
  pointer: string,
): { parent: JsonObject | JsonValue[]; key: string } {
  const parts = pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const key = parts.pop()!;
  let current: JsonValue = value;
  for (const part of parts) {
    const container: JsonObject | JsonValue[] = Array.isArray(current)
      ? current
      : object(current);
    if (!Object.hasOwn(container, part))
      throw new Error(`Missing configuration path ${pointer}`);
    current = Array.isArray(container)
      ? container[Number(part)]!
      : container[part]!;
  }
  const parent = Array.isArray(current) ? current : object(current);
  if (!Object.hasOwn(parent, key))
    throw new Error(`Missing configuration path ${pointer}`);
  return { parent, key };
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
  ): Promise<void> => {
    if (id) plugins[id] = registry.identity(id);
    const sourceConfig = structuredClone(config);
    const localResources: JsonObject = {};
    for (const field of configPathFields(
      schema ?? registry.get(id).configSchema,
      config,
    )) {
      const { parent, key } = pointerParent(config, field.pointer);
      const source = string(
        Array.isArray(parent) ? parent[Number(key)] : parent[key],
      );
      const origins = object(resourceOrigins[owner] ?? {});
      origins[field.pointer] = source;
      resourceOrigins[owner] = origins;
      if (isResourceUrl(source)) continue;
      const info = await lstat(source);
      if (
        info.isSymbolicLink() ||
        (field.kind === 'file' ? !info.isFile() : !info.isDirectory())
      )
        throw new Error(`Invalid locked resource ${owner}${field.pointer}`);
      const slot = digest({ owner, pointer: field.pointer }).slice(0, 32);
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
      localResources[field.pointer] = artifactRef;
      const lockedPath =
        field.kind === 'directory' ? target : join(target, basename(source));
      if (Array.isArray(parent)) parent[Number(key)] = lockedPath;
      else parent[key] = lockedPath;
    }
    if (id)
      bindingVersions[owner] = digest({ id, sourceConfig, localResources });
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
  const reflection: JsonObject | null = recipe.reflection
    ? JSON.parse(JSON.stringify(recipe.reflection))
    : null;
  if (reflection) {
    const implementation = object(reflection.implementation);
    await capture(
      string(implementation.ref),
      object(implementation.config),
      '_reflection',
    );
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
    reflection,
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
      'This experiment predates resumable Policy checkpoints. Start a new experiment.',
    );
  assertDefinitionDigest(locked);
}

export function assertDefinitionDigest(locked: JsonObject): void {
  const { digest: expected, ...content } = locked;
  if (expected !== digest(content))
    throw new Error('Experiment definition lock digest mismatch');
}
