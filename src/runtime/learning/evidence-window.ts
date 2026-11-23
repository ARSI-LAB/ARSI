import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { matchesStepPath } from './trigger.js';
import { digest, string, strings } from '../../shared/json.js';
import type { EvidenceOptions, LearningEvidence } from './evidence.js';

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
const evidenceBinding = (record: JsonObject): string =>
  record.bindingId === '_memory' ? 'memory' : String(record.bindingId);
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
  for await (const entry of entries) {
    options.context.signal?.throwIfAborted();
    if (entry.experimentId === experimentId) owned.push(entry);
  }
  return owned;
}
type EvidenceWindow =
  | { kind: 'saved'; evidence: LearningEvidence }
  | {
      kind: 'window';
      calls: EvidenceCall[];
      selected: EvidenceCall[];
      admitted: Map<string, JsonObject>;
      windowStart: number;
      cutoff: number;
      primaryIds: string[];
      policyScopeId: string;
      excludedMeasurements: Set<string>;
      excludedProducers: Set<string>;
      withheldSelections: Set<string>;
    };
/** Select one durable observation window before expanding authorized references. */
export async function selectEvidenceWindow(
  options: EvidenceOptions,
  note: (code: string, callId?: JsonValue) => void,
): Promise<EvidenceWindow> {
  const { context } = options;
  context.signal?.throwIfAborted();
  const policyScopeId = options.policyScopeId ?? '';
  const kind = options.kind;
  if (options.priorRef) {
    const saved = await context.facts.read('evidence-views', options.priorRef);
    if (
      saved.experimentId !== context.experimentId ||
      saved.view !== 'learning-observations/v1' ||
      saved.boundaryId !== options.identity ||
      saved.policyScopeId !== policyScopeId ||
      saved.moduleKind !== kind ||
      saved.configDigest !== (options.configDigest ?? null) ||
      saved.evidenceView !== (options.view ?? 'execution')
    )
      throw new Error('Learning evidence snapshot ownership mismatch');
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
      record.view === 'learning-observations/v1' &&
      record.policyScopeId === policyScopeId &&
      record.moduleKind === kind &&
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
        'Learning invocation has inconsistent persisted evidence snapshots',
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
  const runs = await ownedFacts(options, 'learning-runs');
  // Evidence from a failed attempt is still available to this Policy step.
  const sameStepAttempts = new Set(
    runs
      .filter(
        (record) =>
          options.stepPath !== undefined &&
          record.policyScopeId === policyScopeId &&
          record.kind === kind &&
          record.stepPath === options.stepPath,
      )
      .map((record) => record.learningId),
  );
  const previous = snapshots.filter(
    (record) =>
      record.view === 'learning-observations/v1' &&
      record.policyScopeId === policyScopeId &&
      record.moduleKind === kind &&
      record.configDigest === (options.configDigest ?? null) &&
      record.boundaryId !== options.identity &&
      !sameStepAttempts.has(record.boundaryId) &&
      Date.parse(String(record.capturedAt)) <= cutoff,
  );
  const triggers = runs.filter(
    (record) =>
      record.policyScopeId === policyScopeId &&
      record.kind === kind &&
      (options.configDigest === undefined ||
        record.configDigest === options.configDigest) &&
      record.learningId !== options.identity &&
      asObject(record.result).learningId !== options.identity &&
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
  const excludedMeasurements = new Set<string>();
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
      matchesPrimary(record, options) &&
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
  const excludedIds = new Set(
    allRecords
      .filter(
        (record) =>
          matchesObservedStep(record, options.observe.excludeSteps) ||
          options.observe.excludeBindings?.includes(evidenceBinding(record)) ||
          (String(record.bindingId).startsWith('_') &&
            !(
              options.kind === 'reflection' && record.bindingId === '_memory'
            ) &&
            record.bindingId !== '_application'),
      )
      .map((record) => String(record.callId)),
  );
  const belongsTo = (id: string, ids: ReadonlySet<string>): boolean => {
    const visited = new Set<string>();
    while (!visited.has(id)) {
      if (ids.has(id)) return true;
      visited.add(id);
      const parent = byId.get(id)?.parentCallId;
      if (typeof parent !== 'string') break;
      id = parent;
    }
    return false;
  };
  // Reflection may observe a Memory update. Its nested generator calls are internal.
  const memoryCalls = new Set(
    allRecords
      .filter((r) => r.bindingId === '_memory')
      .map((r) => String(r.callId)),
  );
  for (const record of allRecords)
    if (
      typeof record.parentCallId === 'string' &&
      belongsTo(record.parentCallId, memoryCalls)
    )
      excludedIds.add(String(record.callId));
  const excludedProducers = new Set<string>();
  for (const record of allRecords) {
    if (
      belongsTo(String(record.callId), excludedIds) ||
      !inScope(record) ||
      ((options.observe.steps || options.observe.bindings) &&
        !matchesPrimary(record, options))
    ) {
      excludedProducers.add(String(record.callId));
      // Selectors can repeat an admitted evaluator's measurementRef.
      const ref = asObject(record.output).measurementRef;
      if (
        typeof ref === 'string' &&
        !String(record.contractId).startsWith('contract.selector')
      )
        excludedMeasurements.add(ref);
    }
  }
  // An artifact selector's Agent can quote any delivery it opened. Keep its
  // decision identity, while withholding derived text and child workspaces.
  const withheldSelections = new Set<string>();
  if (excludedMeasurements.size || excludedProducers.size) {
    for (const record of allRecords) {
      if (
        (record.contractId !== 'contract.selector-artifacts' &&
          record.pluginId !== 'selector.artifact') ||
        !inScope(record)
      )
        continue;
      const candidates = asObject(record.input).candidates;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        const ref = asObject(candidate).measurementRef;
        if (typeof ref !== 'string') continue;
        if (!excludedMeasurements.has(ref)) {
          const measurement = await context.facts
            .read('measurements', ref)
            .catch((error: unknown) => {
              if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT'
              )
                return null;
              throw error;
            });
          if (
            measurement?.experimentId === context.experimentId &&
            !excludedProducers.has(String(measurement.callId))
          )
            continue;
        }
        withheldSelections.add(string(record.callId));
        break;
      }
    }
  }
  const allowed = calls.filter(
    (call) =>
      !belongsTo(String(call.record.callId), excludedIds) &&
      !belongsTo(call.parent, withheldSelections),
  );
  const selected = allowed.filter(
    (call) =>
      matchesPrimary(call.record, options) &&
      (finished(call.record) > windowStart ||
        (finished(call.record) === windowStart &&
          !admitted.has(String(call.record.callId)) &&
          previous.length > 0)),
  );
  const primaryIds = selected.map((call) => string(call.record.callId));
  return {
    kind: 'window',
    calls: allowed,
    selected,
    admitted,
    windowStart,
    cutoff,
    primaryIds,
    policyScopeId,
    excludedMeasurements,
    excludedProducers,
    withheldSelections,
  };
}

export function matchesObservedStep(
  record: JsonObject,
  steps: readonly string[] | undefined,
): boolean {
  return (
    typeof record.path === 'string' &&
    !!steps?.some((location) => matchesStepPath(String(record.path), location))
  );
}
export function matchesPrimary(
  record: JsonObject,
  options: EvidenceOptions,
): boolean {
  const binding = evidenceBinding(record);
  if (
    String(record.bindingId).startsWith('_') &&
    !(options.kind === 'reflection' && binding === 'memory')
  )
    return false;
  return (
    !options.observe.excludeBindings?.includes(binding) &&
    (!options.observe.bindings || options.observe.bindings.includes(binding)) &&
    (!options.observe.steps ||
      matchesObservedStep(record, options.observe.steps)) &&
    !matchesObservedStep(record, options.observe.excludeSteps)
  );
}
