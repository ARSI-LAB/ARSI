import { lstat, readFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
import { recipeDeclarationSchema } from '../../contracts/recipe.js';

export class DefinitionLockError extends Error {
  constructor(
    readonly category: 'unsupported-source' | 'invalid-source',
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionLockError';
  }
}

/** Validate the saved read boundary without loading plugins or restoring resources. */
export function readDefinitionLock(locked: JsonObject): {
  definitionDigest: string;
  policy: JsonObject;
  recipe: JsonObject;
  reflection: JsonValue | null;
} {
  if (locked.schemaVersion !== 'rsi.definition-lock/v1')
    throw new DefinitionLockError(
      'unsupported-source',
      'Unsupported saved definition version.',
    );
  const { digest: expected, ...content } = locked;
  if (typeof expected !== 'string' || expected !== digest(content))
    throw new DefinitionLockError(
      'invalid-source',
      'Saved definition digest does not match its contents.',
    );
  try {
    const policy = object(locked.policy, 'locked policy');
    const recipe = object(locked.recipe, 'locked recipe');
    if (
      policy.schemaVersion !== 'rsi.policy/v1' ||
      recipe.schemaVersion !== 'rsi.recipe/v1'
    )
      throw new DefinitionLockError(
        'unsupported-source',
        'Unsupported saved Policy or Recipe version.',
      );
    validate(recipeDeclarationSchema, recipe, 'locked recipe');
    const policyId = string(policy.id, 'locked policy.id');
    if (!policyId || object(recipe.policy).id !== policyId)
      throw new Error('Saved Policy identity mismatch');
    object(policy.input_schema, 'locked policy.input_schema');
    if (typeof policy.output_schema !== 'boolean')
      object(policy.output_schema, 'locked policy.output_schema');
    if (!Object.hasOwn(policy, 'output'))
      throw new Error('Saved Policy output declaration is missing');
    for (const field of [
      'input',
      'state',
      'require',
      'defaults',
      'config_schema',
      'state_schema',
    ])
      if (policy[field] !== undefined)
        object(policy[field], `locked policy.${field}`);
    if (locked.reflection !== null && locked.reflection !== undefined)
      parseLockedReflection(locked.reflection);
    return {
      definitionDigest: expected,
      policy,
      recipe,
      reflection: locked.reflection ?? null,
    };
  } catch (error) {
    if (error instanceof DefinitionLockError) throw error;
    // Persisted declarations may contain credentials; do not relay validator excerpts.
    throw new DefinitionLockError(
      'invalid-source',
      'Saved definition contains invalid Policy, Recipe, or Reflection data.',
    );
  }
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

/** Lock definitions and owned resource copies before the first business side effect. */
export async function lockDefinition(
  recipe: Recipe,
  registry: Registry,
  artifacts: ArtifactStore,
  directory: string,
): Promise<JsonObject> {
  const declaration = recipe.toJSON();
  const resources: JsonObject[] = [];
  const plugins: JsonObject = {};
  const resourceOrigins: JsonObject = {};
  const capture = async (
    id: string,
    config: JsonObject,
    owner: string,
    schema?: JsonSchema,
  ): Promise<void> => {
    if (id) plugins[id] = registry.identity(id);
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
      const target = join(
        directory,
        digest({ owner, pointer: field.pointer }).slice(0, 32),
      );
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
      await mkdir(directory, { recursive: true });
      await artifacts.materialize(artifactRef, target);
      resources.push({ directory: target, artifactRef });
      const lockedPath =
        field.kind === 'directory' ? target : join(target, basename(source));
      if (Array.isArray(parent)) parent[Number(key)] = lockedPath;
      else parent[key] = lockedPath;
    }
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
    schemaVersion: 'rsi.definition-lock/v1',
    recipe: declaration,
    policy: recipe.policy.toJSON(),
    recipeSourcePath: recipe.sourcePath,
    policySourcePath: recipe.policy.sourcePath,
    plugins,
    resources,
    resourceOrigins,
    reflection,
  };
  return { ...locked, digest: digest(locked) };
}

/** Restore the experiment's saved resources from immutable artifacts. */
export async function restoreDefinition(
  locked: JsonObject,
  artifacts: ArtifactStore,
  directory: string,
): Promise<void> {
  const { digest: expected, ...content } = locked;
  if (expected !== digest(content))
    throw new Error('Experiment definition lock digest mismatch');
  if (!Array.isArray(locked.resources))
    throw new Error('Invalid locked resources');
  for (const raw of locked.resources) {
    const resource = object(raw);
    const target = inside(directory, string(resource.directory));
    const ref = string(resource.artifactRef);
    let exists = true;
    try {
      await lstat(target);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      exists = false;
    }
    if (!exists) await artifacts.materialize(ref, target);
    else if ((await artifacts.capture(target)) !== ref)
      throw new Error(`Locked resource contents differ: ${target}`);
  }
}
