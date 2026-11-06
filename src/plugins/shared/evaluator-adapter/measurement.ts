import type { SdkEvaluatorConfig } from './configuration.js';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type {
  RuntimeContext,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import { typedArtifact } from '../../../contracts/models/measurement.js';
import { object, string, strings } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';
import { clone, plain, redact } from './data.js';
import { itemDetailsSchema, provenanceSchema } from './schemas/index.js';
export function nativeStatus(
  value: JsonValue | undefined,
  signal: AbortSignal,
): string {
  if (signal.aborted || value === 'cancelled') return 'cancelled';
  if (value === 'completed') return 'succeeded';
  if (['error', 'timeout', 'unsupported', 'invalid'].includes(String(value)))
    return 'failed';
  return 'unknown';
}
function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(root) === target)
    throw new Error('Evidence path escapes run directory');
  return target;
}
async function optionalJson(path: string): Promise<JsonObject | null> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Symbolic JSON evidence rejected');
    return object(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}
export async function typed(
  services: RuntimeContext,
  id: string,
  schema: JsonObject,
  value: JsonObject,
): Promise<JsonObject> {
  validate(schema, value, id);
  return typedArtifact(id, schema, await services.artifacts.putJson(value));
}
export async function readMetrics(
  result: JsonObject,
  snapshot: JsonObject | null,
): Promise<JsonObject | null> {
  if (typeof result.runDirectory !== 'string' || !snapshot) return null;
  const metrics = await optionalJson(join(result.runDirectory, 'metrics.json'));
  if (metrics && metrics.snapshotDigest !== snapshot.digest)
    throw new Error('Native metrics snapshotDigest mismatch');
  return metrics;
}
export async function snapshotOf(
  result: JsonObject,
): Promise<JsonObject | null> {
  if (result.snapshot !== undefined) return object(result.snapshot);
  return null;
}
export function validateSnapshot(snapshot: JsonObject): void {
  const run = object(snapshot.run, 'SDK run');
  const runId = string(run.runId, 'SDK runId');
  const ids = strings(run.taskIds, 'SDK taskIds');
  if (new Set(ids).size !== ids.length)
    throw new Error('Duplicate native task IDs');
  if (!Array.isArray(snapshot.records))
    throw new Error('Native snapshot.records must be an array');
  const seen = new Set<string>();
  for (const value of snapshot.records) {
    const record = object(value, 'SDK record');
    const key = object(record.key, 'SDK attempt key');
    const id = string(key.taskId);
    string(key.attemptId);
    if (key.runId !== runId || !ids.includes(id) || seen.has(id))
      throw new Error('Native record identity or selected task set mismatch');
    seen.add(id);
  }
  const pending = strings(
    snapshot.pendingTaskIds ?? [],
    'SDK pending task IDs',
  );
  if (
    new Set(pending).size !== pending.length ||
    pending.some((id) => !ids.includes(id))
  )
    throw new Error('Invalid native pending task IDs');
}
async function archiveAttemptFiles(
  services: RuntimeContext,
  result: JsonObject,
  itemId: string,
  attemptId: string,
  entries: JsonValue[],
): Promise<void> {
  if (typeof result.runDirectory !== 'string') return;
  const tasks = join(result.runDirectory, 'tasks');
  let taskDirs: string[];
  try {
    taskDirs = await readdir(tasks);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
  for (const task of taskDirs) {
    const taskDirectory = inside(tasks, task);
    if ((await lstat(taskDirectory)).isSymbolicLink())
      throw new Error('Symbolic task evidence rejected');
    const attempts = inside(tasks, `${task}/attempts`);
    let attemptDirs: string[];
    try {
      if ((await lstat(attempts)).isSymbolicLink())
        throw new Error('Symbolic attempt evidence rejected');
      attemptDirs = await readdir(attempts);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        continue;
      throw error;
    }
    for (const attempt of attemptDirs) {
      if (attempt !== attemptId) continue;
      const directory = inside(attempts, attempt);
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error('Symbolic attempt evidence rejected');
      const record = await optionalJson(join(directory, 'result.json'));
      if (!record || plain(record.key).taskId !== itemId) continue;
      for (const [sub, kind, access] of [
        ['agent', 'trajectory', 'execution'],
        ['artifacts', 'delivery', 'delivery'],
        ['verifier', 'verifier', 'private'],
      ] as const) {
        const target = inside(directory, sub);
        try {
          const stat = await lstat(target);
          if (stat.isSymbolicLink())
            throw new Error('Symbolic evidence directory rejected');
          if (!stat.isDirectory()) continue;
          const artifactRef = await services.artifacts.capture(target);
          entries.push({
            id: `${itemId}/${attemptId}/${sub}`,
            kind,
            artifactRef,
            mediaType: 'application/vnd.rsi.file-tree+json',
            sizeBytes: null,
            itemId,
            attemptId,
            access,
            integrity: 'complete',
          });
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            continue;
          throw error;
        }
      }
    }
  }
}
export function evaluationStatus(
  value: unknown,
  context: RuntimeContext,
  failed = false,
): string {
  const result =
    value && typeof value === 'object' && !Array.isArray(value)
      ? object(clone(value))
      : {};
  const snapshot =
    result.snapshot === undefined ? null : object(result.snapshot);
  const run = snapshot ? plain(snapshot.run) : {};
  if (context.signal.aborted || run.status === 'cancelled') return 'cancelled';
  if (result.kind === 'ray-jobs' && !snapshot) return 'unknown';
  return failed ? 'failed' : nativeStatus(run.status, context.signal);
}

export async function archiveItemDetails(
  context: RuntimeContext,
  id: string,
  record: JsonObject | null,
  attempts: JsonValue[],
  summary: JsonObject | null,
): Promise<JsonObject> {
  const key = record ? plain(record.key) : {};
  return typed(context, 'measurement.item-details/v1', itemDetailsSchema, {
    selected: record
      ? {
          key,
          status: record.status ?? 'error',
          executionStatus: record.executionStatus ?? null,
          scoreStatus: record.scoreStatus ?? null,
          cleanupStatus: record.cleanupStatus ?? null,
          recordRef: await context.artifacts.putJson(record),
          solveRef: record.solve
            ? await context.artifacts.putJson(record.solve)
            : null,
          verdictRef: record.verdict
            ? await context.artifacts.putJson(record.verdict)
            : null,
        }
      : null,
    attempts: await Promise.all(
      attempts
        .filter((v) => plain(object(v).key).taskId === id)
        .map(async (value) => {
          const a = object(value);
          return {
            key: a.key ?? {},
            ordinal: a.ordinal ?? 0,
            recordRef: a.record
              ? await context.artifacts.putJson(a.record)
              : null,
          };
        }),
    ),
    summary,
  });
}

export async function archiveItemExecution(
  context: RuntimeContext,
  result: JsonObject,
  id: string,
  attemptId: string | null,
  solve: JsonObject | null,
): Promise<JsonValue[]> {
  const entries: JsonValue[] = [];
  if (solve && typeof solve.finalText === 'string') {
    const ref = await context.artifacts.putJson({ text: solve.finalText });
    entries.push({
      id: `${id}/final-text`,
      kind: 'final-text',
      artifactRef: ref,
      mediaType: 'application/json',
      sizeBytes: Buffer.byteLength(solve.finalText),
      itemId: id,
      attemptId,
      access: 'delivery',
      integrity: 'complete',
    });
  }
  if (attemptId)
    await archiveAttemptFiles(context, result, id, attemptId, entries);
  return entries;
}

export async function archiveProvenance(
  context: RuntimeContext,
  native: SdkEvaluatorConfig,
  result: JsonObject,
  snapshot: JsonObject | null,
  nativeResultRef: string,
  metricsEnvelope: JsonObject | null,
): Promise<JsonObject> {
  const run = snapshot ? plain(snapshot.run) : {};
  return typed(context, 'measurement.provenance/v1', provenanceSchema, {
    nativeResult: {
      kind: typeof result.kind === 'string' ? result.kind : null,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      runId: typeof result.runId === 'string' ? result.runId : null,
      jobId: typeof result.jobId === 'string' ? result.jobId : null,
      resultRef: nativeResultRef,
    },
    snapshotDigest:
      typeof snapshot?.digest === 'string' ? snapshot.digest : null,
    runIdentity: run.identity ?? null,
    solverProvenance: run.solverProvenance ?? null,
    source: run.source ?? null,
    configuration: object(redact(native)),
    collectedAt: new Date().toISOString(),
    metricsRevision:
      typeof metricsEnvelope?.revision === 'number'
        ? metricsEnvelope.revision
        : null,
    usageKnown: false,
  });
}
