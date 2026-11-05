import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import type { EmbeddingConfig } from './schema.js';

const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Knowledge and retrieval implementations are explicitly deployed by the caller. */
export async function readKnowledgeResources(
  config: Pick<EmbeddingConfig, 'resourcesDirectory' | 'retrievalScript'>,
): Promise<{
  manifest: JsonObject;
  digest: string;
  workerDigest: string;
  guidelines: string;
}> {
  const directory = await realpath(config.resourcesDirectory);
  const manifestPath = join(directory, 'knowledge/manifest.json');
  const manifestStat = await lstat(manifestPath);
  const manifestLocal = relative(directory, await realpath(manifestPath));
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 2 * 1024 * 1024 ||
    isAbsolute(manifestLocal) ||
    manifestLocal.startsWith('..' + sep)
  )
    throw new Error('Knowledge manifest must be an ordinary file');
  const bytes = await readFile(manifestPath);
  const manifest = object(JSON.parse(bytes.toString('utf8')));
  if (
    manifest.schemaVersion !== 'rsi.operator-knowledge/v1' ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.techniques) ||
    !Array.isArray(manifest.metrics)
  )
    throw new Error('Invalid external operator knowledge manifest');
  const seen = new Set<string>();
  let guidelines = '';
  for (const raw of manifest.resources) {
    const entry = object(raw);
    const path = string(entry.path);
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      /^[A-Za-z]:/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(path)
    )
      throw new Error('Invalid external knowledge resource path');
    seen.add(path);
    const resolved = await realpath(resolve(directory, path));
    const local = relative(directory, resolved);
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + sep) ||
      !(await lstat(resolve(directory, path))).isFile()
    )
      throw new Error('Knowledge resource escapes its directory');
    const content = await readFile(resolved);
    if (sha(content) !== entry.sha256)
      throw new Error(`Knowledge resource changed: ${path}`);
    if (path === manifest.guidelines)
      guidelines = new TextDecoder('utf-8', { fatal: true }).decode(content);
  }
  if (
    manifest.guidelines !== undefined &&
    !seen.has(string(manifest.guidelines))
  )
    throw new Error(
      'Knowledge guidelines must reference an inventoried resource',
    );
  const worker = await lstat(config.retrievalScript);
  if (!worker.isFile() || worker.isSymbolicLink())
    throw new Error('Retrieval script must be an ordinary file');
  return {
    manifest,
    digest: sha(bytes),
    workerDigest: sha(await readFile(config.retrievalScript)),
    guidelines,
  };
}
