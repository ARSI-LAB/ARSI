import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { JsonValue } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export async function readPolicyDocument(
  path: string,
  stack: string[] = [],
): Promise<JsonValue> {
  const absolute = resolve(path);
  if (stack.includes(absolute) || stack.length >= 32)
    throw new Error(`Cyclic or deep document reference ${path}`);
  const parsed = parseDocument(await readFile(absolute, 'utf8'), {
    uniqueKeys: true,
  });
  if (parsed.errors.length)
    throw new Error(parsed.errors.map((e) => e.message).join('; '));
  const value: unknown = parsed.toJS({ maxAliasCount: 0 });
  const data = object(value, absolute);
  async function expand(value: JsonValue): Promise<JsonValue> {
    if (Array.isArray(value)) return Promise.all(value.map(expand));
    if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') {
        if (Object.keys(value).length !== 1)
          throw new Error(`$ref must be sole field in ${absolute}`);
        const [file, pointer] = value.$ref.split('#');
        if (!file || /^[a-z]+:/i.test(file))
          throw new Error(
            `Only local file schema refs are supported: ${value.$ref}`,
          );
        let target = await readPolicyDocument(
          resolve(dirname(absolute), file),
          [...stack, absolute],
        );
        if (pointer) {
          for (const key of pointer.replace(/^\//, '').split('/'))
            target =
              object(target)[key.replaceAll('~1', '/').replaceAll('~0', '~')]!;
        }
        return target;
      }
      const entries = await Promise.all(
        Object.entries(value).map(
          async ([key, child]) => [key, await expand(child)] as const,
        ),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
  return expand(data);
}
