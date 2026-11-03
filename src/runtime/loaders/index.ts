import { readFile } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { parseDocument, isAlias, visit } from 'yaml';
import type {
  Binding,
  JsonObject,
  JsonValue,
  JsonSchema,
  Recipe,
} from '../../contracts/index.js';
import { object, string, unknownKeys, json } from '../../shared/json.js';
import { configPathFields } from '../../shared/config-paths.js';
import { reflectionConfigFile } from '../revisions/declaration.js';

interface BindingOrigins {
  directory: string;
  fields: Record<string, string>;
}
const origins = new WeakMap<Binding, BindingOrigins>();

function resolvePaths(
  config: JsonObject,
  schema: JsonSchema,
  directory: (pointer: string) => string,
): JsonObject {
  const result = structuredClone(config);
  for (const field of configPathFields(schema, result)) {
    const parts = field.pointer
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const last = parts.pop()!;
    let current: JsonValue = result;
    for (const part of parts)
      current = Array.isArray(current)
        ? current[Number(part)]
        : object(current)[part];
    const path = string(
      Array.isArray(current) ? current[Number(last)] : object(current)[last],
    );
    if (
      isAbsolute(path) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
      path.includes('${')
    )
      continue;
    const resolved = resolve(directory(field.pointer), path);
    if (Array.isArray(current)) current[Number(last)] = resolved;
    else object(current)[last] = resolved;
  }
  return result;
}
export async function readYaml(path: string): Promise<JsonObject> {
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  visit(doc, (_key, node) => {
    if (isAlias(node)) throw new Error('YAML aliases are not supported');
  });
  return object(doc.toJS({ maxAliasCount: 0 }), path);
}
export function resolveConfig(
  config: JsonObject,
  directory: string,
  schema: JsonSchema,
): JsonObject {
  return resolvePaths(config, schema, () => directory);
}

/** Resolve paths after registration supplies the Schema, retaining per-field declaration origins. */
export function resolveBindingPaths(
  binding: Binding,
  schema: JsonSchema,
  fallbackDirectory: string,
): void {
  const source = origins.get(binding);
  binding.config = resolvePaths(
    binding.config,
    schema,
    (pointer) =>
      source?.fields[
        pointer
          .slice(1)
          .split('/')[0]
          .replaceAll('~1', '/')
          .replaceAll('~0', '~')
      ] ??
      source?.directory ??
      fallbackDirectory,
  );
}
export function parseBinding(
  value: JsonValue | undefined,
  directory: string,
  depth = 0,
): Binding {
  if (depth >= 32) throw new Error('Binding nesting exceeds 32 levels');
  const b = object(value, 'binding');
  unknownKeys(b, ['ref', 'config', 'bindings'], 'binding');
  const children: Record<string, Binding> = {};
  for (const [name, child] of Object.entries(object(b.bindings ?? {})))
    children[name] = parseBinding(child, directory, depth + 1);
  const parsed: Binding = {
    ref: string(b.ref),
    config: structuredClone(object(b.config ?? {})),
    ...(b.bindings === undefined ? {} : { bindings: children }),
  };
  origins.set(parsed, {
    directory,
    fields: Object.fromEntries(
      Object.keys(parsed.config).map((key) => [key, directory]),
    ),
  });
  return parsed;
}
export function resolveBindings(
  defaults: JsonObject,
  provided: Record<string, Binding>,
  directory: string,
): Record<string, Binding> {
  const result: Record<string, Binding> = {};
  for (const [name, value] of Object.entries(defaults))
    result[name] = parseBinding(value, directory);
  for (const [name, value] of Object.entries(provided)) {
    const previous = result[name];
    result[name] =
      previous?.ref === value.ref
        ? {
            ref: value.ref,
            config: { ...previous.config, ...value.config },
            ...(previous.bindings || value.bindings
              ? { bindings: { ...previous.bindings, ...value.bindings } }
              : {}),
          }
        : value;
    if (previous?.ref === value.ref) {
      const base = origins.get(previous);
      const override = origins.get(value);
      origins.set(result[name], {
        directory: base?.directory ?? directory,
        fields: Object.fromEntries(
          Object.keys(result[name].config).map((key) => [
            key,
            Object.hasOwn(value.config, key)
              ? (override?.fields[key] ?? override?.directory ?? directory)
              : (base?.fields[key] ?? base?.directory ?? directory),
          ]),
        ),
      });
    }
  }
  return result;
}
export async function loadRecipe(path: string): Promise<Recipe> {
  const data = await readYaml(path);
  unknownKeys(
    data,
    [
      'schemaVersion',
      'id',
      'description',
      'application',
      'policy',
      'bindings',
      'budget',
      'reflection',
    ],
    'recipe',
  );
  if (data.schemaVersion !== 'rsi.recipe/v1')
    throw new Error('Recipe requires rsi.recipe/v1');
  const directory = dirname(resolve(path));
  const policy = object(data.policy);
  unknownKeys(policy, ['ref', 'config', 'input'], 'policy');
  const bindings: Record<string, Binding> = {};
  for (const [key, value] of Object.entries(object(data.bindings ?? {})))
    bindings[key] = parseBinding(value, directory);
  const budget: Record<string, number> = {};
  for (const [key, value] of Object.entries(object(data.budget ?? {}))) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`Invalid budget ${key}`);
    if (
      [
        'operations',
        'evaluationRuns',
        'modelCalls',
        'elapsedWallMs',
        'cleanupReserveMs',
      ].includes(key) &&
      (!Number.isSafeInteger(value) ||
        (key.endsWith('Ms') && (value <= 0 || value > 4294967295)))
    )
      throw new Error(`Invalid integer budget ${key}`);
    budget[key] = value;
  }
  let reflection: Recipe['reflection'];
  if (typeof data.reflection === 'boolean')
    throw new Error(
      'recipe.reflection: boolean switches are no longer supported; select a Policy with the intended explicit Reflection calls',
    );
  if (data.reflection !== undefined)
    reflection = {
      configFile: resolve(
        directory,
        reflectionConfigFile(data.reflection, 'recipe.reflection'),
      ),
    };
  const input = object(policy.input ?? {});
  json(input);
  return {
    schemaVersion: 'rsi.recipe/v1',
    id: string(data.id),
    application: parseBinding(data.application, directory),
    policy: {
      ref: string(policy.ref),
      config: object(policy.config ?? {}),
      input,
    },
    bindings,
    budget,
    ...(reflection === undefined ? {} : { reflection }),
  };
}
