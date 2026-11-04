import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { canonical, object } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import {
  staticDiagnosisSchema,
  staticIssueTypes,
  type EmbeddingConfig,
  type StaticIssue,
  type StaticKnowledgeMatch,
} from './schema.js';

export type EmbeddingIdentity = {
  schemaVersion: 'rsi.operator-embedding-identity/v1';
  model: { id: string; revision: string };
  encoding: {
    queryPromptName: 'query';
    normalizeEmbeddings: true;
    device: 'cpu';
    batchSize: 32;
  };
  files: { path: string; sha256: string }[];
};
export type StaticRetrievalResult = {
  schemaVersion: 'rsi.operator-retrieval/v1';
  embeddingDigest: string;
  resourcesDigest: string;
  matches: StaticKnowledgeMatch[];
  knowledgeContext: string;
  omitted: { techniques: string[]; examples: string[] };
  model: { id: string; revision: string };
  runtime: {
    python: string;
    sentenceTransformers: string;
    transformers: string;
    torch: string;
  };
};
const maxBytes = 2 * 1024 * 1024,
  maxLogBytes = 65536;
const pluginDirectory = fileURLToPath(new URL('.', import.meta.url));
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const identitySchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-embedding-identity/v1' },
  model: recordSchema({ id: text, revision: text }),
  encoding: recordSchema({
    queryPromptName: { const: 'query' },
    normalizeEmbeddings: { const: true },
    device: { const: 'cpu' },
    batchSize: { const: 32 },
  }),
  files: {
    type: 'array',
    minItems: 1,
    maxItems: 10000,
    items: recordSchema({ path: text, sha256: hash }),
  },
});
const resultSchema = recordSchema({
  schemaVersion: { const: 'rsi.operator-retrieval/v1' },
  embeddingDigest: hash,
  resourcesDigest: hash,
  matches: {
    type: 'array',
    maxItems: 4,
    items: recordSchema({
      techniqueId: { enum: [...staticIssueTypes] },
      score: { type: 'number', minimum: -1, maximum: 1 },
      issueIndexes: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: { type: 'integer', minimum: 0, maximum: 15 },
      },
      sourceReference: text,
      documentDigest: hash,
      exampleDigest: hash,
    }),
  },
  knowledgeContext: { type: 'string', maxLength: 20000 },
  omitted: recordSchema({
    techniques: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: { enum: [...staticIssueTypes] },
    },
    examples: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: { enum: [...staticIssueTypes] },
    },
  }),
  model: recordSchema({ id: text, revision: text }),
  runtime: recordSchema({
    python: text,
    sentenceTransformers: text,
    transformers: text,
    torch: text,
  }),
});
const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
function safeRelative(path: string): string {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid embedding identity relative file path');
  return path;
}
async function readJson(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error('Retrieval JSON must be an ordinary file of at most 2 MiB');
  return readFile(path);
}
async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest('hex');
}
/** Verify an explicitly deployed immutable model; this never downloads weights. */
export async function readEmbeddingIdentity(
  config: Pick<EmbeddingConfig, 'modelDirectory' | 'identityFile'>,
  signal?: AbortSignal,
): Promise<{ identity: EmbeddingIdentity; digest: string }> {
  signal?.throwIfAborted();
  const bytes = await readJson(config.identityFile);
  const identity = parseConfig<EmbeddingIdentity>(
    identitySchema,
    JSON.parse(bytes.toString('utf8')),
    'Embedding identity',
  );
  const directory = resolve(config.modelDirectory),
    excluded = resolve(config.identityFile);
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
        if (found.length > 10000)
          throw new Error('Embedding model identity exceeds 10000 files');
      } else
        throw new Error(
          'Embedding model identity rejects symlinks and nonordinary files',
        );
    }
  }
  const expected = identity.files
    .map((file) => ({ ...file, path: safeRelative(file.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  await visit(directory);
  found.sort((a, b) => a.path.localeCompare(b.path));
  if (canonical(expected) !== canonical(found))
    throw new Error('Embedding model file identity mismatch');
  return { identity, digest: sha(bytes) };
}
async function groupHasLiveProcesses(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const id of await readdir('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        const raw = await readFile(`/proc/${id}/stat`, 'utf8');
        const parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (Number(parts[2]) === pid && !['Z', 'X'].includes(parts[0]!))
          return true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['ENOENT', 'ESRCH', 'EACCES'].includes(String(error.code))
          )
        )
          throw error;
      }
    }
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}
async function runWorker(
  config: EmbeddingConfig,
  args: string[],
  cwd: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === 'win32')
    throw new Error('Operator retrieval requires POSIX process-group cleanup');
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    failure: Error | undefined;
  const child = spawn(config.python, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CUDA_VISIBLE_DEVICES: '',
      ASCEND_RT_VISIBLE_DEVICES: '',
      HIP_VISIBLE_DEVICES: '',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HOME: join(cwd, 'hf-cache'),
      OMP_NUM_THREADS: '4',
      MKL_NUM_THREADS: '4',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  const stop = (error: Error): void => {
    failure ??= error;
    try {
      killGroup(child.pid);
    } catch (killError) {
      failure = new Error('Retrieval worker cleanup failed', {
        cause: killError,
      });
    }
  };
  const abort = (): void =>
    stop(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Retrieval worker cancelled'),
    );
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => stop(new Error('Retrieval worker timeout')),
    config.timeoutMs,
  );
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > maxLogBytes)
      stop(new Error('Retrieval worker output log exceeds 64 KiB'));
    else stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length + chunk.length > maxLogBytes)
      stop(new Error('Retrieval worker error log exceeds 64 KiB'));
    else stderr = Buffer.concat([stderr, chunk]);
  });
  let code: number | null = null;
  try {
    code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        failure ??= error;
      });
      child.once('close', resolve);
    });
    killGroup(child.pid);
    let live =
      child.pid !== undefined && (await groupHasLiveProcesses(child.pid));
    for (let attempt = 0; live && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      live = await groupHasLiveProcesses(child.pid!);
    }
    await writeFile(
      join(directory, 'process.json'),
      JSON.stringify({
        pid: child.pid ?? null,
        exitCode: code,
        cleanup: live ? 'unknown' : 'confirmed',
        error: failure?.message ?? null,
      }) + '\n',
    );
    await writeFile(join(directory, 'stdout.log'), stdout);
    await writeFile(join(directory, 'stderr.log'), stderr);
    if (live) throw new Error('Retrieval worker cleanup unknown');
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        `Retrieval worker exited ${code}: ${stderr.toString('utf8').trim()}`,
      );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Run one bounded local CPU retrieval and preserve its request, response and cleanup evidence. */
export async function retrieveStaticKnowledge(
  issues: StaticIssue[],
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<StaticRetrievalResult> {
  context.signal.throwIfAborted();
  validate(staticDiagnosisSchema, issues, 'Retrieval issues');
  if (!issues.length)
    throw new Error('Retrieval requires at least one static issue');
  if (
    config.device !== 'cpu' ||
    !Number.isFinite(config.similarityThreshold) ||
    config.similarityThreshold < 0 ||
    config.similarityThreshold > 1 ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0
  )
    throw new Error('Invalid CPU retrieval configuration');
  const { identity, digest: embeddingDigest } = await readEmbeddingIdentity(
    config,
    context.signal,
  );
  const manifestBytes = await readJson(
    join(pluginDirectory, 'knowledge/manifest.json'),
  );
  const resourcesDigest = sha(manifestBytes);
  const manifest = object(JSON.parse(manifestBytes.toString('utf8')));
  if (!Array.isArray(manifest.resources) || !Array.isArray(manifest.techniques))
    throw new Error('Invalid retrieval resource manifest');
  const resources = new Map<string, JsonObject>();
  for (const raw of manifest.resources) {
    const resource = object(raw);
    if (
      typeof resource.path !== 'string' ||
      typeof resource.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(resource.sha256)
    )
      throw new Error('Invalid retrieval resource identity');
    safeRelative(resource.path);
    resources.set(resource.path, resource);
  }
  const techniques = manifest.techniques.map((value) => object(value));
  const directory = join(context.directory, 'retrieval');
  await mkdir(context.directory, { recursive: true });
  await mkdir(directory);
  const temporary = await mkdtemp(join(tmpdir(), 'rsi-operator-retrieval-'));
  try {
    const request = {
      schemaVersion: 'rsi.operator-retrieval-request/v1',
      issues,
      modelDirectory: resolve(config.modelDirectory),
      identityFile: resolve(config.identityFile),
      embeddingDigest,
      resourcesDirectory: pluginDirectory,
      resourcesDigest,
      device: 'cpu',
      similarityThreshold: config.similarityThreshold,
    };
    const requestPath = join(directory, 'request.json'),
      responsePath = join(temporary, 'response.json');
    const body = Buffer.from(JSON.stringify(request) + '\n');
    if (body.length > maxBytes)
      throw new Error('Retrieval worker request exceeds 2 MiB');
    await writeFile(requestPath, body, { flag: 'wx', mode: 0o600 });
    await runWorker(
      config,
      [
        fileURLToPath(new URL('./python/retrieve.py', import.meta.url)),
        '--request',
        requestPath,
        '--response',
        responsePath,
      ],
      temporary,
      directory,
      context.signal,
    );
    const bytes = await readJson(responsePath);
    await writeFile(join(directory, 'response.json'), bytes, { flag: 'wx' });
    const result = parseConfig<StaticRetrievalResult>(
      resultSchema,
      JSON.parse(bytes.toString('utf8')),
      'Retrieval worker result',
    );
    if (
      result.embeddingDigest !== embeddingDigest ||
      result.resourcesDigest !== resourcesDigest ||
      canonical(result.model) !== canonical(identity.model)
    )
      throw new Error('Retrieval worker identity mismatch');
    const found = new Set<string>();
    for (const match of result.matches) {
      if (
        found.has(match.techniqueId) ||
        match.score < config.similarityThreshold ||
        match.issueIndexes.some(
          (index) => issues[index]?.issue_type !== match.techniqueId,
        )
      )
        throw new Error('Retrieval worker match identity or coverage mismatch');
      found.add(match.techniqueId);
      const technique = object(
        techniques.find((value) => value.id === match.techniqueId),
      );
      if (
        resources.get(String(technique.document))?.sha256 !==
          match.documentDigest ||
        resources.get(String(technique.example))?.sha256 !== match.exampleDigest
      )
        throw new Error('Retrieval worker resource digest mismatch');
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

export type MetricsKnowledgeMatch = {
  techniqueId: string;
  score: number;
  issueIndexes: number[];
  sourceReference: string;
  documentDigest: string;
  exampleDigest: string | null;
};
export type MetricsRetrievalResult = Omit<StaticRetrievalResult, 'matches'> & {
  matches: MetricsKnowledgeMatch[];
};
export class MetricsRetrievalUnavailable extends Error {}

/** Metrics use the bottleneck query across the metric knowledge tree, without static type filtering. */
export async function retrieveMetricsKnowledge(
  query: string,
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<MetricsRetrievalResult> {
  if (!query.trim() || query.length > 16000)
    throw new Error('Invalid metric retrieval query');
  const { identity, digest: embeddingDigest } = await readEmbeddingIdentity(
    config,
    context.signal,
  );
  const manifestBytes = await readJson(
    join(pluginDirectory, 'knowledge/manifest.json'),
  );
  const resourcesDigest = sha(manifestBytes);
  const manifest = object(JSON.parse(manifestBytes.toString('utf8')));
  if (!Array.isArray(manifest.metrics) || !Array.isArray(manifest.resources))
    throw new Error('Metrics knowledge manifest is missing');
  const techniques = manifest.metrics.map((value) => object(value));
  const resources = new Map(
    manifest.resources.map((entry) => {
      const value = object(entry);
      return [String(value.path), String(value.sha256)];
    }),
  );
  const directory = join(context.directory, 'retrieval');
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rsi-metrics-retrieval-'));
  try {
    const request = {
      schemaVersion: 'rsi.operator-retrieval-request/v1',
      mode: 'metrics',
      query,
      modelDirectory: resolve(config.modelDirectory),
      identityFile: resolve(config.identityFile),
      embeddingDigest,
      resourcesDirectory: pluginDirectory,
      resourcesDigest,
      device: 'cpu',
      similarityThreshold: config.similarityThreshold,
    };
    const requestPath = join(directory, 'request.json'),
      responsePath = join(temporary, 'response.json');
    await writeFile(requestPath, JSON.stringify(request) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await runWorker(
        config,
        [
          fileURLToPath(new URL('./python/retrieve.py', import.meta.url)),
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
      const process = object(
        JSON.parse(await readFile(join(directory, 'process.json'), 'utf8')),
      );
      if (process.cleanup !== 'confirmed') throw error;
      throw new MetricsRetrievalUnavailable(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const bytes = await readJson(responsePath);
    await writeFile(join(directory, 'response.json'), bytes, { flag: 'wx' });
    const schema = structuredClone(resultSchema);
    const properties = object(schema.properties);
    properties.matches = {
      type: 'array',
      maxItems: 3,
      items: recordSchema({
        techniqueId: text,
        score: { type: 'number', minimum: -1, maximum: 1 },
        issueIndexes: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: { const: 0 },
        },
        sourceReference: text,
        documentDigest: hash,
        exampleDigest: { anyOf: [hash, { type: 'null' }] },
      }),
    };
    properties.omitted = recordSchema({
      techniques: { type: 'array', items: text },
      examples: { type: 'array', items: text },
    });
    const result = parseConfig<MetricsRetrievalResult>(
      schema,
      JSON.parse(bytes.toString('utf8')),
      'Metric retrieval result',
    );
    if (
      result.embeddingDigest !== embeddingDigest ||
      result.resourcesDigest !== resourcesDigest ||
      canonical(result.model) !== canonical(identity.model)
    )
      throw new Error('Metric retrieval identity mismatch');
    const ids = new Set<string>();
    for (const match of result.matches) {
      const technique = techniques.find(
        (entry) => entry.id === match.techniqueId,
      );
      if (
        !technique ||
        ids.has(match.techniqueId) ||
        match.score < config.similarityThreshold ||
        resources.get(String(technique.document)) !== match.documentDigest ||
        (technique.example === null
          ? match.exampleDigest !== null
          : resources.get(String(technique.example)) !== match.exampleDigest)
      )
        throw new Error('Metric retrieval match identity mismatch');
      ids.add(match.techniqueId);
    }
    if (!result.matches.length && result.knowledgeContext !== '')
      throw new Error('Metric retrieval invented unmatched context');
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
