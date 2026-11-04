import { readFile } from 'node:fs/promises';
import { parseDocument, isAlias, visit } from 'yaml';
import type { JsonObject } from '../../contracts/json.js';
import { object } from '../../shared/json.js';

export async function readYaml(path: string): Promise<JsonObject> {
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  visit(doc, (_key, node) => {
    if (isAlias(node)) throw new Error('YAML aliases are not supported');
  });
  return object(doc.toJS({ maxAliasCount: 0 }), path);
}
