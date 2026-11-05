import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import type {
  EmbeddingConfig,
  OperatorProposerConfig,
  OperatorAgentStage,
} from './schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';

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

export type HardwareContext = { text: string; sha256: string };

/** Read the full user document; values are context, never implicit hardware defaults. */
export async function readHardwareContext(
  path: string,
): Promise<HardwareContext> {
  if (typeof path !== 'string' || path.trim() === '')
    throw new Error('hardwareContextFile must be a nonempty file path');
  let bytes: Buffer;
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error('expected an ordinary file without symlinks');
    if ((stat.mode & 0o444) === 0) throw new Error('file is not readable');
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(
      `hardwareContextFile could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new Error('hardwareContextFile must contain valid UTF-8 text', {
      cause: error,
    });
  }
  if (text.trim() === '')
    throw new Error('hardwareContextFile must not be empty');
  return { text, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export type OperatorResources = {
  digest: string;
  knowledgeDigest: string;
  workerDigest: string;
  prompts: Record<OperatorAgentStage, string>;
  metricsGenerate: string;
  guidelines: string;
};

const directory = fileURLToPath(new URL('./', import.meta.url));

export async function loadOperatorResources(
  config: OperatorProposerConfig,
): Promise<OperatorResources> {
  const external = await readKnowledgeResources(config.embedding);
  const contents: Record<string, string> = {};
  for (const name of [
    'diagnose',
    'diagnose-metrics',
    'generate',
    'generate-metrics',
    'repair',
    'summarize',
  ]) {
    contents[name] = await readFile(
      join(directory, 'prompts', `${name}.md`),
      'utf8',
    );
  }
  const get = (name: string): string => string(contents[name]);
  return {
    digest: digest({
      prompts: contents,
      knowledge: external.digest,
      worker: external.workerDigest,
      taskModel: await sourceIdentity(import.meta.url, [
        '../shared/file-application/kernel-task',
      ]),
    }),
    knowledgeDigest: external.digest,
    workerDigest: external.workerDigest,
    prompts: {
      diagnose: get('diagnose'),
      'diagnose-metrics': get('diagnose-metrics'),
      generate: get('generate'),
      repair: get('repair'),
      summarize: get('summarize'),
    },
    metricsGenerate: get('generate-metrics'),
    guidelines: external.guidelines,
  };
}
