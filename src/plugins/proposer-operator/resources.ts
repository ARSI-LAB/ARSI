import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type JsonObject, type RuntimeContext } from '../../contracts/index.js';
import { canonical, digest, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { runRetrievalWorker } from './retrieval-worker.js';
import {
  type EmbeddingConfig,
  type OperatorProposerConfig,
  type HardwareContext,
  type OperatorResources,
  type EmbeddingIdentity,
  type MetricsKnowledgeMatch,
  type OperatorRetrievalResult,
  type StaticRetrievalResult,
  type MetricsRetrievalResult,
  type KnowledgeResources,
  type KnowledgeQuery,
  embeddingIdentitySchema,
  staticRetrievalSchema,
  metricsRetrievalSchema,
} from './schema.js';
import {
  type StaticIssue,
  type StaticKnowledgeMatch,
  staticDiagnosisSchema,
} from '../shared/operator-attempt/schema.js';

export const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
function safeRelativeResource(path: string): string {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid operator resource identity relative file path');
  return path;
}
async function readRetrievalJson(
  path: string,
  maxPayloadBytes?: number,
): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile())
    throw new Error('Retrieval JSON must be an ordinary file');
  if (maxPayloadBytes !== undefined && stat.size > maxPayloadBytes)
    throw new Error(
      `Retrieval JSON exceeds maxPayloadBytes (${maxPayloadBytes})`,
    );
  return readFile(path);
}
async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest('hex');
}
export async function readKnowledgeResources(
  config: Pick<
    EmbeddingConfig,
    'resourcesDirectory' | 'retrievalScript' | 'maxPayloadBytes'
  >,
): Promise<KnowledgeResources> {
  const directory = await realpath(config.resourcesDirectory);
  const manifestPath = join(directory, 'knowledge/manifest.json');
  const manifestLocal = relative(directory, await realpath(manifestPath));
  if (isAbsolute(manifestLocal) || manifestLocal.startsWith('..' + sep))
    throw new Error(
      'Knowledge manifest must be an ordinary file inside its directory',
    );
  const bytes = await readRetrievalJson(manifestPath, config.maxPayloadBytes);
  const manifest = object(JSON.parse(bytes.toString('utf8')));
  if (
    manifest.schemaVersion !== 'rsi.operator-knowledge/v1' ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.techniques) ||
    !Array.isArray(manifest.metrics)
  )
    throw new Error('Invalid external operator knowledge manifest');
  const resources = new Map<string, string>();
  let guidelines = '';
  for (const raw of manifest.resources) {
    const entry = object(raw);
    const path = safeRelativeResource(string(entry.path));
    if (resources.has(path))
      throw new Error('Duplicate external knowledge resource path');
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
    resources.set(path, string(entry.sha256));
    if (path === manifest.guidelines)
      guidelines = new TextDecoder('utf-8', { fatal: true }).decode(content);
  }
  if (
    manifest.guidelines !== undefined &&
    !resources.has(string(manifest.guidelines))
  )
    throw new Error(
      'Knowledge guidelines must reference an inventoried resource',
    );
  const worker = await lstat(config.retrievalScript);
  if (!worker.isFile())
    throw new Error('Retrieval script must be an ordinary file');
  return {
    manifest,
    resources,
    digest: sha(bytes),
    workerDigest: await fileDigest(config.retrievalScript),
    guidelines,
  };
}

/** Verify the exact deployed model inventory before invoking its CPU worker. */
export async function readEmbeddingIdentity(
  config: Pick<
    EmbeddingConfig,
    'modelDirectory' | 'identityFile' | 'maxPayloadBytes'
  >,
  signal?: AbortSignal,
): Promise<{ identity: EmbeddingIdentity; digest: string }> {
  signal?.throwIfAborted();
  const bytes = await readRetrievalJson(
    config.identityFile,
    config.maxPayloadBytes,
  );
  const identity = parseConfig<EmbeddingIdentity>(
    embeddingIdentitySchema,
    JSON.parse(bytes.toString('utf8')),
    'Embedding identity',
  );
  const directory = resolve(config.modelDirectory);
  const excluded = resolve(config.identityFile);
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Embedding model directory must be an ordinary directory');
  const found: { path: string; sha256: string }[] = [];
  async function visit(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      signal?.throwIfAborted();
      const path = join(current, name);
      if (resolve(path) === excluded) continue;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        found.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: await fileDigest(path, signal),
        });
      } else
        throw new Error(
          'Embedding model identity rejects symlinks and nonordinary files',
        );
    }
  }
  const expected = identity.files.map((file) => ({
    ...file,
    path: safeRelativeResource(file.path),
  }));
  await visit(directory);
  expected.sort((a, b) => a.path.localeCompare(b.path));
  found.sort((a, b) => a.path.localeCompare(b.path));
  if (canonical(expected) !== canonical(found))
    throw new Error('Embedding model file identity mismatch');
  return { identity, digest: sha(bytes) };
}
export class MetricsRetrievalUnavailable extends Error {}

/** Static and measured bottleneck queries share one bounded retrieval protocol. */
async function retrieveKnowledge<Match extends MetricsKnowledgeMatch>(
  query: KnowledgeQuery,
  schema: JsonObject,
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<OperatorRetrievalResult<Match>> {
  context.signal.throwIfAborted();
  if (
    config.device !== 'cpu' ||
    !Number.isFinite(config.similarityThreshold) ||
    config.similarityThreshold < 0 ||
    config.similarityThreshold > 1 ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 0 ||
    config.timeoutMs > 2147483647 ||
    [config.maxPayloadBytes, config.maxLogBytes].some(
      (value) =>
        value !== undefined && (!Number.isSafeInteger(value) || value <= 0),
    )
  )
    throw new Error('Invalid CPU retrieval configuration');
  const { identity, digest: embeddingDigest } = await readEmbeddingIdentity(
    config,
    context.signal,
  );
  const bundle = await readKnowledgeResources(config);
  const rawTechniques =
    'issues' in query ? bundle.manifest.techniques : bundle.manifest.metrics;
  if (!Array.isArray(rawTechniques))
    throw new Error('Knowledge techniques must be an array');
  const techniques = rawTechniques.map((entry) => object(entry));
  const directory = join(context.directory, 'retrieval');
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rsi-operator-retrieval-'));
  try {
    const request = {
      schemaVersion: 'rsi.operator-retrieval-request/v1',
      ...query,
      modelDirectory: resolve(config.modelDirectory),
      identityFile: resolve(config.identityFile),
      embeddingDigest,
      resourcesDirectory: resolve(config.resourcesDirectory),
      resourcesDigest: bundle.digest,
      device: 'cpu',
      similarityThreshold: config.similarityThreshold,
    };
    const requestPath = join(directory, 'request.json');
    const responsePath = join(temporary, 'response.json');
    const body = Buffer.from(JSON.stringify(request) + '\n');
    if (
      config.maxPayloadBytes !== undefined &&
      body.length > config.maxPayloadBytes
    )
      throw new Error(
        `Retrieval worker request exceeds maxPayloadBytes (${config.maxPayloadBytes})`,
      );
    await writeFile(requestPath, body, { flag: 'wx', mode: 0o600 });
    try {
      await runRetrievalWorker(
        config,
        [
          resolve(config.retrievalScript),
          '--request',
          requestPath,
          '--response',
          responsePath,
        ],
        temporary,
        directory,
        context.signal,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      if ('issues' in query) throw error;
      const outcome = object(
        JSON.parse(await readFile(join(directory, 'process.json'), 'utf8')),
      );
      if (outcome.cleanup !== 'confirmed') throw error;
      throw new MetricsRetrievalUnavailable(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const bytes = await readRetrievalJson(responsePath, config.maxPayloadBytes);
    await writeFile(join(directory, 'response.json'), bytes, { flag: 'wx' });
    const raw = parseConfig<
      Omit<OperatorRetrievalResult<Match>, 'workerDigest'>
    >(schema, JSON.parse(bytes.toString('utf8')), 'Retrieval worker result');
    if ((await fileDigest(config.retrievalScript)) !== bundle.workerDigest)
      throw new Error('Retrieval script changed during execution');
    const result = { ...raw, workerDigest: bundle.workerDigest };
    if (
      result.embeddingDigest !== embeddingDigest ||
      result.resourcesDigest !== bundle.digest ||
      canonical(result.model) !== canonical(identity.model)
    )
      throw new Error('Retrieval worker identity mismatch');
    const seen = new Set<string>();
    for (const match of result.matches) {
      const technique = techniques.find(
        (entry) => entry.id === match.techniqueId,
      );
      if (
        !technique ||
        seen.has(match.techniqueId) ||
        match.score < config.similarityThreshold ||
        ('issues' in query &&
          match.issueIndexes.some(
            (index) => query.issues[index]?.issue_type !== match.techniqueId,
          )) ||
        bundle.resources.get(string(technique.document)) !==
          match.documentDigest ||
        (technique.example === null
          ? match.exampleDigest !== null
          : bundle.resources.get(string(technique.example)) !==
            match.exampleDigest)
      )
        throw new Error('Retrieval worker match identity or coverage mismatch');
      seen.add(match.techniqueId);
    }
    if (!result.matches.length && result.knowledgeContext !== '')
      throw new Error('Retrieval worker invented unmatched knowledge context');
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    context.signal.throwIfAborted();
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function retrieveStaticKnowledge(
  issues: StaticIssue[],
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<StaticRetrievalResult> {
  context.signal.throwIfAborted();
  validate(staticDiagnosisSchema, issues, 'Retrieval issues');
  if (!issues.length)
    throw new Error('Retrieval requires at least one static issue');
  return retrieveKnowledge<StaticKnowledgeMatch>(
    { issues },
    staticRetrievalSchema,
    config,
    context,
  );
}
export async function retrieveMetricsKnowledge(
  query: string,
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<MetricsRetrievalResult> {
  if (!query.trim()) throw new Error('Invalid metric retrieval query');
  return retrieveKnowledge<MetricsKnowledgeMatch>(
    { mode: 'metrics', query },
    metricsRetrievalSchema,
    config,
    context,
  );
}

/** Read the full user document without supplying implicit hardware defaults. */
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
  return { text, sha256: sha(bytes) };
}
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
  ]) {
    const path = join(config.promptsDirectory, `${name}.md`);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(`promptsDirectory: cannot read ${name}.md at ${path}`, {
        cause: error,
      });
    }
    if (!content.trim())
      throw new Error(`promptsDirectory: ${name}.md must not be empty`);
    contents[name] = content;
  }
  const get = (name: string): string => string(contents[name]);
  return {
    digest: digest({
      prompts: contents,
      knowledge: external.digest,
      worker: external.workerDigest,
      taskModel: await sourceIdentity(import.meta.url, [
        '../shared/operator-task',
      ]),
    }),
    knowledgeDigest: external.digest,
    workerDigest: external.workerDigest,
    prompts: {
      diagnose: get('diagnose'),
      'diagnose-metrics': get('diagnose-metrics'),
      generate: get('generate'),
      repair: get('repair'),
    },
    metricsGenerate: get('generate-metrics'),
    guidelines: external.guidelines,
  };
}
