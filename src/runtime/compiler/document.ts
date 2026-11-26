import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { JsonValue } from '../../contracts/index.js';
import { object } from '../../shared/json.js';

export async function readPolicyDocument(
  path: string,
  stack: string[] = [],
  origins?: Map<string, string>,
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
  async function expand(
    value: JsonValue,
    position: string,
  ): Promise<JsonValue> {
    origins?.set(position, dirname(absolute));
    if (Array.isArray(value))
      return Promise.all(
        value.map((entry, i) => expand(entry, position + '/' + i)),
      );
    if (value && typeof value === 'object') {
      if (typeof value.$ref === 'string') {
        if (Object.keys(value).length !== 1)
          throw new Error(`$ref must be sole field in ${absolute}`);
        const [file, pointer] = value.$ref.split('#');
        if (!file || /^[a-z]+:/i.test(file))
          throw new Error(
            `Only local file schema refs are supported: ${value.$ref}`,
          );
        const referencedOrigins = origins && new Map<string, string>();
        let target = await readPolicyDocument(
          resolve(dirname(absolute), file),
          [...stack, absolute],
          referencedOrigins,
        );
        if (pointer) {
          for (const key of pointer.replace(/^\//, '').split('/'))
            target =
              object(target)[key.replaceAll('~1', '/').replaceAll('~0', '~')]!;
        }
        if (referencedOrigins) {
          const prefix = pointer ?? '';
          for (const [source, directory] of referencedOrigins)
            if (source === prefix || source.startsWith(prefix + '/'))
              origins!.set(position + source.slice(prefix.length), directory);
        }
        return target;
      }
      const entries = await Promise.all(
        Object.entries(value).map(
          async ([key, child]) =>
            [
              key,
              await expand(
                child,
                position +
                  '/' +
                  key.replaceAll('~', '~0').replaceAll('/', '~1'),
              ),
            ] as const,
        ),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
  return expand(data, '');
}
