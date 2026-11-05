import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { digest, string, strings } from '../../shared/json.js';
import type { EvidenceOptions, ReflectionEvidence } from './evidence.js';

export interface EvidenceCall {
  record: JsonObject;
  input: JsonObject;
  output: JsonObject;
  frame: string;
  parent: string;
}

export const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
const terminal = (record: JsonObject): boolean =>
  ['succeeded', 'failed', 'cancelled', 'unknown'].includes(
    String(record.status),
  );
export const finished = (record: JsonObject): number =>
  Date.parse(String(record.finishedAt));

async function ownedFacts(
  options: EvidenceOptions,
  kind: string,
): Promise<JsonObject[]> {
  const { facts, experimentId } = options.context;
  const entries = facts.scan ? facts.scan(kind) : await facts.list(kind);
  const owned: JsonObject[] = [];
  for await (const entry of entries)
    if (entry.experimentId === experimentId) owned.push(entry);
  return owned;
}
type EvidenceWindow =
  | { kind: 'saved'; evidence: ReflectionEvidence }
  | {
      kind: 'window';
      calls: EvidenceCall[];
      selected: EvidenceCall[];
      admitted: Map<string, JsonObject>;
      windowStart: number;
      cutoff: number;
      primaryIds: string[];
      policyScopeId: string;
      moduleKey: string;
    };
/** Select one durable observation window before expanding authorized references. */
export async function selectEvidenceWindow(
  options: EvidenceOptions,
  note: (code: string, callId?: JsonValue) => void,
): Promise<EvidenceWindow> {
  const { context } = options;
  context.signal?.throwIfAborted();
  const policyScopeId = options.policyScopeId ?? '';
  const moduleKey = options.moduleKey ?? '';
  if (options.priorRef) {
    const saved = await context.facts.read('evidence-views', options.priorRef);
    if (
      saved.experimentId !== context.experimentId ||
      saved.view !== 'reflection-observations/v1' ||
      saved.boundaryId !== options.identity ||
      saved.policyScopeId !== policyScopeId ||
      saved.moduleKey !== moduleKey ||
      saved.configDigest !== (options.configDigest ?? null) ||
      saved.evidenceView !== (options.view ?? 'execution')
    )
      throw new Error('Reflection evidence snapshot ownership mismatch');
    return {
      kind: 'saved',
      evidence: {
        ref: options.priorRef,
        callCount: Number(saved.callCount),
        callIds: strings(saved.callIds),
      },
    };
  }
  const cutoff = Date.parse(options.capturedAt);
  if (!Number.isFinite(cutoff))
    throw new Error('Invalid evidence boundary time');
  const snapshots = await ownedFacts(options, 'evidence-views');
  const prepared = snapshots.filter(
    (record) =>
      record.view === 'reflection-observations/v1' &&
      record.policyScopeId === policyScopeId &&
      record.moduleKey === moduleKey &&
      record.boundaryId === options.identity,
  );
  if (prepared.length) {
    const refs = new Set(
      prepared.map((record) => 'evidence-' + digest(record)),
    );
    if (
      refs.size !== 1 ||
      prepared[0]!.capturedAt !== options.capturedAt ||
      prepared[0]!.configDigest !== (options.configDigest ?? null) ||
      prepared[0]!.evidenceView !== (options.view ?? 'execution')
    )
      throw new Error(
        'Reflection invocation has inconsistent persisted evidence snapshots',
      );
    return {
      kind: 'saved',
      evidence: {
        ref: [...refs][0]!,
        callCount: Number(prepared[0]!.callCount),
        callIds: strings(prepared[0]!.callIds),
      },
    };
  }
  const previous = snapshots.filter(
    (record) =>
      record.view === 'reflection-observations/v1' &&
      record.policyScopeId === policyScopeId &&
      record.moduleKey === moduleKey &&
      record.boundaryId !== options.identity &&
      Date.parse(String(record.capturedAt)) <= cutoff,
  );
  const triggers = (await ownedFacts(options, 'reflection')).filter(
    (record) =>
      record.policyScopeId === policyScopeId &&
      record.configFile === moduleKey &&
      (options.configDigest === undefined ||
        record.configDigest === options.configDigest) &&
      record.reflectionId !== options.identity &&
      asObject(record.result).reflectionId !== options.identity &&
      (options.stepPath === undefined ||
        record.stepPath !== options.stepPath) &&
      Number.isFinite(Date.parse(String(record.startedAt))) &&
      Date.parse(String(record.startedAt)) <= cutoff,
  );
  const previousTrigger = triggers.reduce(
    (latest, record) => Math.max(latest, Date.parse(String(record.startedAt))),
    -Infinity,
  );
  const windowStart = previous.reduce(
    (latest, record) => Math.max(latest, Date.parse(String(record.capturedAt))),
    previousTrigger,
  );
  const admitted = new Map<string, JsonObject>();
  for (const snapshot of previous)
    for (const id of strings(snapshot.callIds))
      admitted.set(id, {
        boundaryId: snapshot.boundaryId ?? null,
        capturedAt: snapshot.capturedAt ?? null,
      });
  const calls: EvidenceCall[] = [];
  const allRecords = await ownedFacts(options, 'calls');
  const byId = new Map(
    allRecords.map((record) => [String(record.callId), record]),
  );
  const inScope = (record: JsonObject): boolean => {
    if (!policyScopeId || policyScopeId === 'root') return true;
    const visited = new Set<string>();
    let current: JsonObject | undefined = record;
    while (
      current &&
      typeof current.parentCallId === 'string' &&
      !visited.has(current.parentCallId)
    ) {
      if (current.parentCallId === policyScopeId) return true;
      visited.add(current.parentCallId);
      current = byId.get(current.parentCallId);
    }
    return false;
  };
  for (const record of allRecords) {
    context.signal?.throwIfAborted();
    if (!inScope(record)) continue;
    if (
      options.names.includes(String(record.bindingId)) &&
      terminal(record) &&
      !Number.isFinite(finished(record))
    )
      note('terminal-call-completion-time-unavailable', record.callId);
    if (
      !terminal(record) ||
      !Number.isFinite(finished(record)) ||
      finished(record) > cutoff
    )
      continue;
    const path = typeof record.path === 'string' ? record.path : '';
    calls.push({
      record,
      input: asObject(record.input),
      output: asObject(record.output),
      frame: path.split('/').slice(0, -1).join('/'),
      parent:
        typeof record.parentCallId === 'string' ? record.parentCallId : '',
    });
  }
  calls.sort(
    (a, b) =>
      finished(a.record) - finished(b.record) ||
      String(a.record.callId).localeCompare(String(b.record.callId)),
  );
  const selected = calls.filter(
    (call) =>
      options.names.includes(String(call.record.bindingId)) &&
      finished(call.record) > windowStart,
  );
  const primaryIds = selected.map((call) => string(call.record.callId));
  return {
    kind: 'window',
    calls,
    selected,
    admitted,
    windowStart,
    cutoff,
    primaryIds,
    policyScopeId,
    moduleKey,
  };
}
