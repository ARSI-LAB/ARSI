import { isAbsolute, resolve } from 'node:path';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../../contracts/json.js';
import { configPathFields, isResourceUrl } from '../../shared/config-paths.js';
import { object, string } from '../../shared/json.js';

/** Resolve only Schema-marked fields, using each field's declaration directory. */
export function resolvePaths(
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
