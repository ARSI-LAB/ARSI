import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RuntimeContext,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import {
  canonical,
  digest,
  json,
  object,
  string,
  strings,
} from '../../shared/json.js';
import {
  fullEvidenceText,
  projectEvidence,
} from '../services/facts/evidence.js';
import { projectEvidenceFiles } from '../services/facts/evidence-files.js';
import { safeId } from '../storage/index.js';

interface EvidenceOptions {
  context: RuntimeContext;
  names: string[];
  identity: string;
  capturedAt: string;
  maxBytes: number;
  priorRef?: string;
  policyScopeId?: string;
  moduleKey?: string;
  configDigest?: string;
  stepPath?: string;
  directory?: string;
  view?: 'execution' | 'training-summary';
  isAgentBinding?(binding: string): boolean;
  currentRevisionRefs?: JsonObject;
}
export interface ReflectionEvidence {
  ref: string | null;
  callCount: number;
  callIds: string[];
}
interface Call {
  record: JsonObject;
  input: JsonObject;
  output: JsonObject;
  frame: string;
  parent: string;
}
const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
const terminal = (record: JsonObject): boolean =>
  ['succeeded', 'failed', 'cancelled', 'unknown'].includes(
    String(record.status),
  );
const finished = (record: JsonObject): number =>
  Date.parse(String(record.finishedAt));
const task = (call: Call): JsonValue => {
  const value = call.input.taskId ?? call.input.task ?? call.input.dataset;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
};
function safeText(
  value: JsonValue,
  format: 'json' | 'text' | 'jsonl' = 'json',
): string {
  let projectedNodes = 0;
  const project = (raw: JsonValue, depth = 0): JsonValue => {
    if (depth > 64 || ++projectedNodes > 200000)
      return '[omitted-depth-or-size]';
    if (typeof raw === 'string' && /^[\s]*[\[{]/.test(raw)) {
      try {
        const parsed: unknown = JSON.parse(raw);
        json(parsed);
        if (parsed !== null && typeof parsed === 'object')
          return canonical(project(parsed, depth + 1));
      } catch {
        /* Ordinary non-JSON evidence remains text. */
      }
    }
    if (Array.isArray(raw))
      return raw.map((entry) => project(entry, depth + 1));
    if (raw !== null && typeof raw === 'object') {
      if (
        raw.view === 'training-summary' ||
        raw.schemaVersion === 'rsi.evaluation-feedback/v1'
      )
        return '[scoring-side feedback omitted from execution projection]';
      return Object.fromEntries(
        Object.entries(raw)
          .filter(
            ([key]) =>
              !/^(?:evaluation|evaluationFeedback|trainingSummary|datasetHints?|returnedHints?|gradingDiagnostics|feedback)$/i.test(
                key,
              ),
          )
          .map(([key, entry]) => [key, project(entry, depth + 1)]),
      );
    }
    return raw;
  };
  const content =
    format === 'jsonl' && typeof value === 'string'
      ? value
          .split('\n')
          .map((line) => {
            try {
              const parsed: unknown = JSON.parse(line);
              json(parsed);
              return canonical(project(parsed));
            } catch {
              return line;
            }
          })
          .join('\n')
      : typeof value === 'string' && format === 'text'
        ? value
        : canonical(project(value));
  return fullEvidenceText(content, format).text;
}
/** A persisted, scope-local trigger snapshot. References, not arbitrary strings, authorize expansion. */
export async function collectReflectionEvidence(
  options: EvidenceOptions,
): Promise<ReflectionEvidence> {
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
      ref: options.priorRef,
      callCount: Number(saved.callCount),
      callIds: strings(saved.callIds),
    };
  }
  const cutoff = Date.parse(options.capturedAt);
  if (!Number.isFinite(cutoff))
    throw new Error('Invalid evidence boundary time');
  const snapshots = await context.facts.list('evidence-views');
  const prepared = snapshots.filter(
    (record) =>
      record.experimentId === context.experimentId &&
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
      ref: [...refs][0]!,
      callCount: Number(prepared[0]!.callCount),
      callIds: strings(prepared[0]!.callIds),
    };
  }
  const previous = snapshots.filter(
    (record) =>
      record.experimentId === context.experimentId &&
      record.view === 'reflection-observations/v1' &&
      record.policyScopeId === policyScopeId &&
      record.moduleKey === moduleKey &&
      record.boundaryId !== options.identity &&
      Date.parse(String(record.capturedAt)) <= cutoff,
  );
  const triggers = (await context.facts.list('reflection')).filter(
    (record) =>
      record.experimentId === context.experimentId &&
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
  const diagnostics: JsonObject[] = [];
  const note = (code: string, callId?: JsonValue): void => {
    if (diagnostics.length < 128)
      diagnostics.push({ code, callId: callId ?? null });
  };
  const calls: Call[] = [];
  const allRecords = (await context.facts.list('calls')).filter(
    (record) => record.experimentId === context.experimentId,
  );
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
      record.experimentId !== context.experimentId ||
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
  const files: JsonObject = {};
  const sourceTextPaths = new Map<string, string>();
  const entries: JsonObject[] = [];
  const lateResults: JsonObject[] = [];
  const comparisons: JsonObject[] = [];
  const included = new Set<string>();
  const seenMeasurements = new Set<string>();
  const measurements: JsonObject[] = [];
  let bytes = 0;
  const limit = options.maxBytes;
  const store = (path: string, content: string): void => {
    const available = Math.max(0, limit - bytes);
    const data = Buffer.from(content);
    if (data.length > available) {
      files[path] =
        data.subarray(0, available).toString('utf8') +
        '\n[truncated: Reflection evidence byte limit]';
      bytes = limit;
      note('virtual-file-truncated');
    } else {
      files[path] = content;
      bytes += data.length;
    }
  };
  const addMeasurement = async (
    ref: string,
    source: JsonObject,
  ): Promise<void> => {
    if (seenMeasurements.has(ref)) return;
    const measurement = await context.facts
      .read('measurements', ref)
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          note('missing-measurement', source.callId);
          return null;
        }
        throw error;
      });
    if (!measurement) return;
    if (measurement.experimentId !== context.experimentId) {
      note('foreign-measurement', source.callId);
      return;
    }
    seenMeasurements.add(ref);
    measurements.push(measurement);
  };
  const expandReferences = async (
    value: JsonObject,
    source: JsonObject,
  ): Promise<void> => {
    for (const ref of strings(value.evidenceRefs ?? [])) {
      if (!ref.startsWith('evidence-')) {
        await addMeasurement(ref, source);
        continue;
      }
      const snapshot = await context.facts.read('evidence-views', ref);
      if (snapshot.experimentId !== context.experimentId) {
        note('foreign-referenced-evidence', source.callId);
        continue;
      }
      if (
        typeof snapshot.capturedAt !== 'string' ||
        Date.parse(snapshot.capturedAt) > cutoff
      ) {
        note('referenced-evidence-outside-boundary', source.callId);
        continue;
      }
      for (const nested of strings(snapshot.measurementRefs ?? []))
        await addMeasurement(nested, source);
    }
  };
  const artifactText = async (
    ref: string,
    path: string,
    source: JsonObject,
  ): Promise<void> => {
    if (!ref.startsWith('artifact:')) return;
    try {
      const value = await context.artifacts.readJson(ref);
      const record = asObject(value);
      if (record.access === 'private' || record.visibility === 'private') {
        note('private-artifact-excluded', source.callId);
        return;
      }
      if (record.kind === 'file-tree' && Array.isArray(record.files)) {
        const index: JsonObject[] = [];
        for (const [number, raw] of record.files.entries()) {
          const file = object(raw);
          if (typeof file.base64 !== 'string' || typeof file.path !== 'string')
            throw new Error('Invalid referenced file tree');
          const source = {
            artifactRef: ref,
            pointer: `/files/${number}`,
            path: file.path,
          };
          const sourceKey = canonical(source);
          const outputPath =
            sourceTextPaths.get(sourceKey) ?? `${path}/${number}.txt`;
          try {
            const content = new TextDecoder('utf8', { fatal: true }).decode(
              Buffer.from(file.base64, 'base64'),
            );
            if (!sourceTextPaths.has(sourceKey)) {
              store(
                outputPath,
                safeText(
                  content,
                  /\.jsonl$/i.test(file.path)
                    ? 'jsonl'
                    : /\.json$/i.test(file.path)
                      ? 'json'
                      : 'text',
                ),
              );
              sourceTextPaths.set(sourceKey, outputPath);
            }
            index.push({
              artifactRef: ref,
              sourcePath: file.path,
              path: outputPath,
              inspection: 'text',
            });
          } catch {
            index.push({
              artifactRef: ref,
              sourcePath: file.path,
              inspection: 'uninspected',
              reason: 'not readable UTF-8 text',
            });
          }
        }
        store(`${path}/index.json`, safeText(index));
      } else store(path, safeText(value));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        note('referenced-artifact-unavailable', source.callId);
      else throw error;
    }
  };
  const addCall = async (
    call: Call,
    role: string,
    origin: JsonObject = {},
  ): Promise<void> => {
    context.signal?.throwIfAborted();
    const id = string(call.record.callId);
    if (included.has(id)) return;
    included.add(id);
    const path = `context/reflection/calls/${safeId(id)}.json`;
    store(path, safeText(call.record));
    const entry: JsonObject = {
      callId: id,
      bindingId: call.record.bindingId ?? null,
      revisionRef: call.record.revisionRef ?? null,
      version: call.record.revisionRef ?? 'initial',
      parentCallId: call.record.parentCallId ?? null,
      taskId: task(call),
      status: call.record.status ?? 'unknown',
      parentCandidateRef: call.input.parent ?? null,
      outputCandidateRef: call.output.candidateRef ?? null,
      measurementRef: call.output.measurementRef ?? null,
      diffRef: call.output.diffRef ?? null,
      relationships: {
        parentCandidate:
          typeof call.input.parent === 'string' ? call.input.parent : null,
        producedCandidate:
          typeof call.output.candidateRef === 'string'
            ? call.output.candidateRef
            : null,
        measurement:
          typeof call.output.measurementRef === 'string'
            ? call.output.measurementRef
            : null,
        sources: Array.isArray(call.input.sources)
          ? call.input.sources.slice(0, 128).map((raw) => {
              const source = asObject(raw);
              return {
                candidate:
                  typeof source.candidateRef === 'string'
                    ? source.candidateRef
                    : null,
                measurement:
                  typeof source.measurementRef === 'string'
                    ? source.measurementRef
                    : null,
              };
            })
          : [],
        sourcesOmitted: Array.isArray(call.input.sources)
          ? Math.max(0, call.input.sources.length - 128)
          : 0,
      },
      role,
      path,
      ...origin,
    };
    entries.push(entry);
    await expandReferences(call.input, call.record);
    if (typeof call.output.measurementRef === 'string')
      await addMeasurement(call.output.measurementRef, call.record);
    if (typeof call.output.diffRef === 'string')
      await artifactText(
        call.output.diffRef,
        `context/reflection/calls/${id}-patch.json`,
        call.record,
      );
    // Only an explicitly selected Memory call grants access to its retained snapshot.
    if (options.names.includes(String(call.record.bindingId)))
      for (const key of ['memoryRef'])
        if (typeof call.output[key] === 'string')
          await artifactText(
            call.output[key],
            `context/reflection/calls/${id}-${key}.json`,
            call.record,
          );
    const descendants = new Set([id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const child of calls)
        if (
          descendants.has(child.parent) &&
          !descendants.has(String(child.record.callId))
        ) {
          descendants.add(String(child.record.callId));
          changed = true;
        }
    }
    let traceCount = 0;
    for (const child of calls) {
      const childId = String(child.record.callId);
      if (
        childId === id ||
        !descendants.has(childId) ||
        !options.directory ||
        !options.isAgentBinding?.(String(child.record.bindingId))
      )
        continue;
      const childPath = `context/reflection/calls/${id}-descendant-${safeId(childId)}.json`;
      store(childPath, safeText(child.record));
      try {
        const diagnostic = await readFile(
          join(
            options.directory,
            'experiments',
            safeId(context.experimentId),
            'calls',
            safeId(childId),
            'diagnostics.jsonl',
          ),
          'utf8',
        );
        store(
          `context/reflection/calls/${id}-trace-${childId}.jsonl`,
          safeText(diagnostic, 'jsonl'),
        );
        traceCount++;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    entry.trace = traceCount ? 'available' : 'unavailable';
  };
  for (const call of selected) await addCall(call, 'primary');
  const producers = calls.filter(
    (call) =>
      typeof call.output.candidateRef === 'string' &&
      typeof call.input.parent === 'string',
  );
  for (const source of calls.filter(
    (call) =>
      primaryIds.includes(String(call.record.callId)) ||
      admitted.has(String(call.record.callId)),
  )) {
    if (typeof source.output.candidateRef !== 'string') continue;
    for (const result of calls) {
      if (
        result.input.candidateRef !== source.output.candidateRef ||
        !source.frame ||
        result.frame !== source.frame ||
        !source.parent ||
        result.parent !== source.parent ||
        finished(result.record) < finished(source.record)
      )
        continue;
      const matches = producers.filter(
        (producer) =>
          producer.output.candidateRef === result.input.candidateRef &&
          producer.frame === result.frame &&
          producer.parent === result.parent &&
          finished(producer.record) <= finished(result.record),
      );
      if (matches.length !== 1 || matches[0] !== source) {
        note('ambiguous-candidate-result', result.record.callId);
        continue;
      }
      const isLate = admitted.has(String(source.record.callId));
      if (isLate && finished(result.record) <= windowStart) continue;
      const origin = {
        sourceCallId: source.record.callId!,
        sourceTaskId: task(source),
        sourceRevisionRef: source.record.revisionRef ?? null,
        originalWindow: admitted.get(String(source.record.callId)) ?? null,
      };
      await addCall(
        result,
        isLate ? 'late-result' : 'associated-result',
        origin,
      );
      if (isLate && !primaryIds.includes(String(result.record.callId)))
        lateResults.push({ callId: result.record.callId!, ...origin });
      else if (isLate) {
        const existing = entries.find(
          (entry) => entry.callId === result.record.callId,
        );
        if (existing) {
          existing.lateAssociatedResult = true;
          existing.association = origin;
        }
      }
    }
  }
  const revisionFiles = new Set<string>();
  for (const binding of options.names) {
    const bindingCalls = selected.filter(
      (call) => call.record.bindingId === binding,
    );
    const latestObserved = bindingCalls.at(-1);
    const currentRef =
      options.currentRevisionRefs?.[binding] ??
      latestObserved?.record.revisionRef;
    if (typeof currentRef !== 'string') continue;
    const revision = await context.facts.read('revisions', currentRef);
    if (
      revision.experimentId !== context.experimentId ||
      revision.binding !== binding
    ) {
      note(
        'revision-comparison-ownership-unavailable',
        latestObserved?.record.callId,
      );
      continue;
    }
    const currentCall = bindingCalls
      .filter(
        (call) =>
          call.record.revisionRef === currentRef ||
          (call.record.revisionRef == null && revision.kind === 'initial'),
      )
      .at(-1);
    const parent =
      typeof revision.parentRef === 'string'
        ? await context.facts.read('revisions', revision.parentRef)
        : null;
    if (!parent) continue;
    if (
      parent.experimentId !== context.experimentId ||
      parent.binding !== binding
    ) {
      note(
        'parent-revision-comparison-ownership-unavailable',
        currentCall?.record.callId,
      );
      continue;
    }
    const priorCalls = (currentCall ? calls : bindingCalls).filter(
      (call) =>
        call.record.bindingId === binding &&
        (call.record.revisionRef === parent.ref ||
          (call.record.revisionRef == null && parent.kind === 'initial')) &&
        (!currentCall || finished(call.record) <= finished(currentCall.record)),
    );
    const previousCall = priorCalls.at(-1);
    if (currentCall && previousCall)
      await addCall(previousCall, 'retrospective-comparison');
    const comparison: JsonObject = {
      binding,
      revisionRef: revision.ref ?? currentRef,
      parentRevisionRef: parent.ref ?? null,
      callId: currentCall?.record.callId ?? null,
      previousCallId: previousCall?.record.callId ?? null,
      beforeExecution: previousCall ? 'available' : 'not-in-window',
      afterExecution: currentCall ? 'available' : 'not-in-window',
      resourceOnly: !currentCall,
      taskComparison:
        !currentCall ||
        !previousCall ||
        task(currentCall) === null ||
        task(previousCall) === null
          ? 'unknown'
          : canonical(task(currentCall)) === canonical(task(previousCall))
            ? 'same'
            : 'different',
      limitation: currentCall
        ? 'Observational comparison; task and input differences limit causal attribution.'
        : 'No current-version execution call is included in this window. Resource differences do not establish after-change execution or benefit.',
    };
    comparisons.push(comparison);
    for (const record of [parent, revision]) {
      if (
        typeof record.resourceRef !== 'string' ||
        typeof record.ref !== 'string'
      ) {
        note('historical-resource-unavailable', currentCall?.record.callId);
        continue;
      }
      if (revisionFiles.has(record.ref)) continue;
      revisionFiles.add(record.ref);
      const tree = asObject(
        await context.artifacts.readJson(record.resourceRef),
      );
      const resourceFiles = Array.isArray(tree.files) ? tree.files : [];
      for (const raw of resourceFiles) {
        const file = object(raw);
        if (
          typeof file.path !== 'string' ||
          !file.path.startsWith(`bindings/${binding}/resources/`) ||
          typeof file.base64 !== 'string'
        )
          continue;
        try {
          const content = new TextDecoder('utf8', { fatal: true }).decode(
            Buffer.from(file.base64, 'base64'),
          );
          store(
            `context/reflection/versions/${record.ref}/${file.path}`,
            safeText(content, 'text'),
          );
        } catch {
          note(
            'binary-resource-content-uninspected',
            currentCall?.record.callId,
          );
        }
      }
    }
    if (
      typeof parent.resourceRef === 'string' &&
      typeof revision.resourceRef === 'string'
    ) {
      const before = asObject(
        await context.artifacts.readJson(parent.resourceRef),
      );
      const after = asObject(
        await context.artifacts.readJson(revision.resourceRef),
      );
      const scoped = (tree: JsonObject): Map<string, string> =>
        new Map(
          (Array.isArray(tree.files) ? tree.files : [])
            .map(asObject)
            .filter(
              (file) =>
                typeof file.path === 'string' &&
                String(file.path).startsWith(
                  `bindings/${binding}/resources/`,
                ) &&
                typeof file.base64 === 'string',
            )
            .map((file) => {
              let content: string;
              try {
                content = new TextDecoder('utf8', { fatal: true }).decode(
                  Buffer.from(String(file.base64), 'base64'),
                );
              } catch {
                content = `[uninspected binary resource ${digest(file.base64!)}]`;
              }
              return [String(file.path), content];
            }),
        );
      const oldFiles = scoped(before),
        newFiles = scoped(after);
      const patches: string[] = [];
      for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
        const oldText = oldFiles.get(path),
          newText = newFiles.get(path);
        if (oldText === newText) continue;
        patches.push(
          `--- ${parent.ref}/${path}\n+++ ${revision.ref}/${path}\n` +
            (oldText === undefined
              ? ''
              : oldText
                  .split('\n')
                  .map((line) => '-' + line)
                  .join('\n')) +
            '\n' +
            (newText === undefined
              ? ''
              : newText
                  .split('\n')
                  .map((line) => '+' + line)
                  .join('\n')),
        );
      }
      store(
        `context/reflection/versions/${revision.ref}-difference.patch`,
        safeText(patches.join('\n'), 'text'),
      );
    }
  }
  const sources: JsonObject[] = [];
  const sourceDescriptors = new Map<string, JsonObject>();
  if (measurements.length) {
    const projected = await projectEvidenceFiles({
      measurements,
      artifacts: context.artifacts,
      view: 'execution',
      maxBytes: limit,
    });
    for (const rawMeasurement of projected.measurements as JsonValue[]) {
      const measurement = object(rawMeasurement);
      measurement.sourceMeasurement = measurement.measurementRef ?? null;
      for (const rawEntry of measurement.entries as JsonValue[]) {
        const entry = object(rawEntry);
        entry.sourceItem = entry.itemId ?? null;
        entry.sourceAttempt = entry.attemptId ?? null;
        for (const rawFile of entry.files as JsonValue[]) {
          const file = object(rawFile);
          const source = object(file.source);
          const sourceKey = canonical(source);
          // A PDF can be valid UTF-8 without being readable document text.
          // Keep the captured bytes for the document parser, not the generic text view.
          if (/\.(xlsx|docx|pdf)$/i.test(String(source.path))) {
            delete file.path;
            file.inspection = 'uninspected';
          }
          if (typeof file.path === 'string') {
            const existing = sourceTextPaths.get(sourceKey);
            if (existing) file.path = existing;
            else {
              const content = object(projected.files)[file.path];
              if (typeof content !== 'string')
                throw new Error(
                  `Reflection evidence file ${file.path}: expected text`,
                );
              store(file.path, content);
              sourceTextPaths.set(sourceKey, file.path);
            }
          }
          if (file.inspection !== 'uninspected') continue;
          const association = {
            measurementRef: measurement.measurementRef ?? null,
            measurement: measurement.measurementRef ?? null,
            itemId: entry.itemId ?? null,
            task: entry.itemId ?? null,
            attemptId: entry.attemptId ?? null,
            kind: entry.kind ?? null,
          };
          const existing = sourceDescriptors.get(sourceKey);
          if (existing) {
            const associations = existing.associations;
            if (
              Array.isArray(associations) &&
              !associations.some(
                (value) => canonical(value) === canonical(association),
              )
            )
              associations.push(association);
            continue;
          }
          const descriptor: JsonObject = {
            ...source,
            access: entry.kind === 'delivery' ? 'delivery' : 'execution',
            kind: entry.kind ?? null,
            measurementRef: measurement.measurementRef ?? null,
            sizeBytes: file.sizeBytes ?? null,
            associations: [association],
          };
          sources.push(descriptor);
          sourceDescriptors.set(sourceKey, descriptor);
        }
      }
    }
    store(
      'context/reflection/evaluation-index.json',
      safeText({ ...projected, files: {} }),
    );
    if (options.view === 'training-summary') {
      const feedback = await projectEvidence({
        measurements,
        artifacts: context.artifacts,
        view: 'training-summary',
        maxBytes: Math.min(limit, 1024 * 1024),
      });
      // This projection alone allows normalized scores and diagnostics; ordinary records stay execution-filtered.
      store('context/reflection/training-summary.json', canonical(feedback));
    }
  }
  const index = object(
    JSON.parse(
      safeText({
        calls: entries,
        lateResults,
        comparisons,
        diagnostics,
        window: {
          after: Number.isFinite(windowStart)
            ? new Date(windowStart).toISOString()
            : null,
          through: options.capturedAt,
        },
        limitations: [
          'Resource snapshots show prepared contents, not proof of earlier use.',
          'A final revision without a later call has no after-change execution trace.',
        ],
      }),
    ),
  );
  store('context/reflection/index.json', safeText(index));
  const payload: JsonObject = {
    experimentId: context.experimentId,
    policyScopeId,
    moduleKey,
    configDigest: options.configDigest ?? null,
    measurementRefs: [...seenMeasurements],
    index,
    files,
    sources,
    view: 'reflection-observations/v1',
    evidenceView: options.view ?? 'execution',
    capturedAt: options.capturedAt,
    boundaryId: options.identity,
    windowStart: Number.isFinite(windowStart)
      ? new Date(windowStart).toISOString()
      : null,
    callCount: selected.length + lateResults.length,
    callIds: primaryIds,
    includedCallIds: [...included],
  };
  const ref = 'evidence-' + digest(payload);
  await context.facts.write('evidence-views', ref, payload);
  return {
    ref,
    callCount: selected.length + lateResults.length,
    callIds: primaryIds,
  };
}
