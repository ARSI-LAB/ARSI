import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import {
  evaluationFeedbackSchema,
  typedArtifact,
} from '../../contracts/models/measurement.js';
import { validate } from '../../shared/schema.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
import { redact } from '../shared/evaluator-adapter/data.js';

const record = (v: JsonValue | undefined): JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const finite = (v: JsonValue | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const pointer = (s: string): string =>
  s.replaceAll('~', '~0').replaceAll('/', '~1');
const list = (v: JsonValue | undefined): JsonValue[] =>
  Array.isArray(v) ? v : [];

/** Translate SDK quality verdicts, not dataset-specific grading logic. Raw plans stay private. */
export async function buildTrainingFeedback(
  artifacts: ArtifactStore,
  itemId: string,
  native: JsonObject | null,
  verifierTreeRef: string | null = null,
): Promise<{ metrics: JsonObject; evaluation: JsonObject }> {
  const value = record(redact(native ?? {}));
  const verdict = record(value.verdict);
  const details = record(verdict.details);
  const evidence = record(details.evidence);
  const nativeRef = await artifacts.putJson(value);
  const source = (path: string): JsonObject => ({
    artifactRef: nativeRef,
    pointer: path,
  });
  const explicitStatus = value.scoreStatus;
  const scoreStatus = [
    'valid',
    'invalid',
    'pending',
    'not-applicable',
  ].includes(String(explicitStatus))
    ? String(explicitStatus)
    : typeof verdict.passed === 'boolean' || finite(verdict.score)
      ? 'valid'
      : 'unknown';
  const valid = scoreStatus === 'valid';
  const rewards = record(details.rewards);
  const metrics: JsonObject = {};
  async function metric(
    id: string,
    v: JsonValue | undefined,
    path: string,
  ): Promise<void> {
    const definitionRef = await definition(
      artifacts,
      id,
      'native',
      'scalar',
      path,
      'selected native task verdict; no rescaling',
    );
    metrics[id] =
      valid && finite(v)
        ? {
            definitionRef,
            status: 'available',
            value: { kind: 'scalar', value: v },
            source: source(path),
          }
        : {
            definitionRef,
            status: 'unavailable',
            value: null,
            reason: valid
              ? 'Native value was not supplied'
              : `Scoring is ${scoreStatus}`,
            source: source(path),
          };
  }
  await metric('score', verdict.score, '/verdict/score');
  for (const [name, v] of Object.entries(rewards))
    await metric(
      `reward.${name}`,
      v,
      `/verdict/details/rewards/${pointer(name)}`,
    );

  const checks: JsonObject[] = [];
  const diagnostics: JsonObject[] = [];
  let truncated = false;
  const seenChecks = new Set<string>();
  function check(
    id: string,
    status: string,
    score: JsonValue | undefined,
    reason: JsonValue | undefined,
    src: JsonObject,
  ): void {
    const key = `${id}\n${status}`;
    if (seenChecks.has(key)) return;
    seenChecks.add(key);
    if (checks.length >= 100) {
      truncated = true;
      return;
    }
    const text = typeof reason === 'string' ? reason : null;
    checks.push({
      id: id.slice(0, 1024),
      status,
      score: finite(score) ? score : null,
      reason: text?.slice(0, 2000) ?? null,
      source: src,
    });
    if (id.length > 1024 || (text?.length ?? 0) > 2000) truncated = true;
  }
  function diagnostic(
    kind: string,
    code: JsonValue | undefined,
    message: string,
    src: JsonObject,
  ): void {
    if (!message) return;
    if (diagnostics.length >= 32) {
      truncated = true;
      return;
    }
    const limited = Buffer.from(message).subarray(0, 8192).toString('utf8');
    const cut = limited !== message;
    diagnostics.push({
      kind,
      code: typeof code === 'string' && code ? code : null,
      message: limited,
      source: src,
      truncated: cut,
    });
    truncated ||= cut;
  }
  function log(text: string, src: JsonObject, kind: string): void {
    // Pytest progress/summary lines are observations, not a complete failure inventory.
    for (const match of text.matchAll(
      /(?:^|\n)\s*(?:FAILED\s+([^\s]+)|([^\s]+::[^\n]+?)\s+FAILED(?:\s|$))/g,
    ))
      check(match[1] ?? match[2], 'fail', null, null, src);
    diagnostic(kind, null, text, src);
  }
  function verdicts(raw: JsonValue | undefined, base: string): void {
    list(raw).forEach((v, i) => {
      const c = record(v);
      if (typeof c.item_id === 'string' && typeof c.status === 'string')
        check(c.item_id, c.status, c.score, c.reason, source(`${base}/${i}`));
    });
  }
  verdicts(evidence.verdicts, '/verdict/details/evidence/verdicts');
  list(evidence.judges).forEach((v, i) => {
    const j = record(v),
      metadata = record(j.metadata);
    const base = `/verdict/details/evidence/judges/${i}`;
    verdicts(j.verdicts, `${base}/verdicts`);
    for (const stream of ['stdout', 'stderr'])
      if (typeof metadata[stream] === 'string')
        log(
          metadata[stream],
          source(`${base}/metadata/${stream}`),
          `verifier-${stream}`,
        );
    list(j.errors).forEach((error, n) => {
      if (typeof error === 'string')
        diagnostic(
          'verifier-error',
          null,
          error,
          source(`${base}/errors/${n}`),
        );
    });
  });
  for (const kind of ['errors', 'warnings'])
    list(value[kind]).forEach((v, i) => {
      const e = record(v);
      if (typeof e.message === 'string')
        diagnostic(
          kind === 'errors' ? 'execution-error' : 'execution-warning',
          e.code,
          e.message,
          source(`/${kind}/${i}`),
        );
    });
  if (verifierTreeRef) {
    const tree = parseFileTree(await artifacts.readJson(verifierTreeRef));
    for (const [index, f] of tree.files.entries()) {
      if (
        !['test_output.txt', 'test-stdout.txt', 'test-stderr.txt'].includes(
          String(f.path),
        )
      )
        continue;
      const buffer = Buffer.from(f.base64, 'base64');
      const text = String(redact(buffer.subarray(0, 65536).toString('utf8')));
      if (buffer.length > 65536) truncated = true;
      log(
        text,
        {
          artifactRef: verifierTreeRef,
          pointer: `/files/${index}`,
        },
        `verifier-log:${String(f.path)}`,
      );
    }
  }
  const feedback: JsonObject = {
    schemaVersion: 'rsi.evaluation-feedback/v1',
    itemId,
    attemptId:
      typeof record(value.key).attemptId === 'string'
        ? record(value.key).attemptId
        : null,
    executionStatus:
      typeof value.executionStatus === 'string'
        ? value.executionStatus
        : typeof value.status === 'string'
          ? value.status
          : 'unknown',
    scoreStatus,
    passed:
      valid && typeof verdict.passed === 'boolean' ? verdict.passed : null,
    primaryReward:
      typeof details.primary === 'string' && details.primary
        ? details.primary
        : null,
    passThreshold: finite(details.passThreshold) ? details.passThreshold : null,
    checks,
    checksComplete: null,
    diagnostics,
    truncated,
    source: source(''),
  };
  validate(evaluationFeedbackSchema, feedback, 'evaluation feedback');
  return {
    metrics,
    evaluation: typedArtifact(
      'rsi.evaluation-feedback/v1',
      evaluationFeedbackSchema,
      await artifacts.putJson(feedback),
    ),
  };
}

/** Mean only when every selected task supplies the same native metric; never fill missing values with zero. */
export async function aggregateTrainingMetrics(
  artifacts: ArtifactStore,
  items: JsonObject[],
  itemsRef: string,
): Promise<JsonObject> {
  const output: JsonObject = {};
  const ids = new Set([
    'score',
    ...items.flatMap((item) => Object.keys(record(item.metrics))),
  ]);
  for (const id of ids) {
    const entries = items.map((item) => record(record(item.metrics)[id]));
    const values = entries.map((m) => record(m.value).value);
    const available =
      entries.length > 0 &&
      entries.every((m, i) => m.status === 'available' && finite(values[i]));
    const definitionRef = await definition(
      artifacts,
      id,
      'native',
      'scalar',
      `items.metrics.${id}`,
      'arithmetic mean of selected task values; unavailable unless all requested tasks have valid values',
    );
    output[id] = available
      ? {
          definitionRef,
          status: 'available',
          value: {
            kind: 'scalar',
            value:
              values.reduce<number>(
                (sum, v) => sum + (typeof v === 'number' ? v : 0),
                0,
              ) / entries.length,
          },
          source: { artifactRef: itemsRef, pointer: '/items' },
        }
      : {
          definitionRef,
          status: 'unavailable',
          value: null,
          reason: 'Not all requested tasks have a valid native value',
          source: { artifactRef: itemsRef, pointer: '/items' },
        };
  }
  return output;
}
