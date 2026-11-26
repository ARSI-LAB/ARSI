import { isAbsolute, resolve } from 'node:path';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../../contracts/json.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { object, string } from '../../shared/json.js';

export function pointerParent(
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

/** Resolve only Schema-marked fields, using each field's declaration directory. */
export function resolvePaths(
  config: JsonObject,
  schema: JsonSchema,
  directory: (pointer: string) => string,
): JsonObject {
  const result = structuredClone(config);
  for (const field of configPathFields(schema, result)) {
    const { parent: current, key: last } = pointerParent(result, field.pointer);
    const path = string(
      Array.isArray(current) ? current[Number(last)] : object(current)[last],
    );
    if (isAbsolute(path) || isResourceUrl(path) || path.includes('${'))
      continue;
    const absolute = resolve(directory(field.pointer), path);
    if (Array.isArray(current)) current[Number(last)] = absolute;
    else object(current)[last] = absolute;
  }
  return result;
}

export function resolveConfig(
  config: JsonObject,
  directory: string,
  schema: JsonSchema,
): JsonObject {
  return resolvePaths(config, schema, () => directory);
}
