import { fullEvidenceText } from '../../shared/evidence-redaction.js';
import type { RuntimeEvolutionEvidenceView } from '../../contracts/runtime-evolution.js';
import { memberPath, parseCoveringRoots } from './resources.js';
import { parseFileTree } from '../../contracts/index.js';
import { persistFact } from '../storage/persistence-error.js';
import { readAgentTrace } from '../storage/agent-records.js';
import { join } from 'node:path';
import type {
  RuntimeContext,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import {
  canonical,
  digest,
  object,
  string,
  strings,
} from '../../shared/json.js';
import { projectEvidence } from '../services/facts/evidence.js';
import { projectEvidenceFiles } from '../services/facts/evidence-files.js';
import { safeId } from '../storage/index.js';
import type { EvidenceCall } from './evidence-window.js';
import type { RuntimeEvolutionObserve } from './schema.js';
import { projectCandidateEvidence } from './candidate-evidence.js';
import { executionEvidencePackets } from '../services/facts/evidence-packets.js';
import {
  selectEvidenceWindow,
  asObject,
  finished,
  matchesPrimary,
} from './evidence-window.js';

export interface EvidenceOptions {
  context: RuntimeContext;
  identity: string;
  capturedAt: string;
  maxBytes?: number;
  priorRef?: string;
  policyScopeId?: string;
  kind: 'memory' | 'reflection';
  observe: RuntimeEvolutionObserve;
  configDigest?: string;
  stepPath?: string;
  directory?: string;
  view?: RuntimeEvolutionEvidenceView;
  isAgentBinding?(binding: string): boolean;
  currentRevisionRefs?: JsonObject;
}
export interface EvolutionEvidence {
  ref: string | null;
  callCount: number;
  callIds: string[];
}
function task(call: EvidenceCall): JsonValue {
  const value = call.input.taskId ?? call.input.task ?? call.input.dataset;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** A persisted, scope-local trigger snapshot. References, not arbitrary strings, authorize expansion. */
export async function collectEvolutionEvidence(
  options: EvidenceOptions,
): Promise<EvolutionEvidence> {
  const { context } = options;
  const view = options.view ?? 'training';
  const includeExecutionDetails = view !== 'training-summary';
  const includeTrainingFeedback = view !== 'execution';
  const diagnostics: JsonObject[] = [];
  const note = (code: string, callId?: JsonValue): void => {
    diagnostics.push({ code, callId: callId ?? null });
  };
  const window = await selectEvidenceWindow(options, note);
  if (window.kind === 'saved') return window.evidence;
  const {
    calls,
    selected,
    admitted,
    windowStart,
    cutoff,
    primaryIds,
    policyScopeId,
    excludedMeasurements,
    excludedProducers,
    withheldSelections,
    restrictedWorkspaces,
  } = window;
  const files: JsonObject = {};
  const callFiles = new Map<EvidenceCall, JsonObject>();
  const sourceTextPaths = new Map<string, string>();
  const entries: JsonObject[] = [];
  const lateResults: JsonObject[] = [];
  const included = new Set<string>();
  const seenMeasurements = new Set<string>();
  const measurements: JsonObject[] = [];
  let bytes = 0;
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedDocument = canonical({ truncated: true });
  // Adding another property to the single-ref object replaces its closing brace with a comma.
  const wrapperBytes =
    Buffer.byteLength(
      canonical({
        indexes: [{ ref: 'evidence-' + '0'.repeat(64) }],
        previews: [],
      }),
    ) - 1;
  // Leave room for the window index and the evidence ref enveloping it in the Agent project.
  const indexReserve = Number.isFinite(limit)
    ? Math.min(
        limit,
        Math.max(
          wrapperBytes + Buffer.byteLength(truncatedDocument),
          Math.floor(limit / 5),
        ),
      )
    : 0;
  const detailLimit = limit - indexReserve;
  const store = (
    path: string,
    content: string,
    available = detailLimit - bytes,
  ): void => {
    const data = Buffer.from(content);
    if (data.length > available) {
      const marker = '\n[truncated: runtime evolution evidence byte limit]';
      const suffix = Buffer.byteLength(marker) <= available ? marker : '';
      let end = Math.max(0, available - Buffer.byteLength(suffix));
      while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
      files[path] = data.subarray(0, end).toString('utf8') + suffix;
      bytes += Buffer.byteLength(files[path]);
      note('virtual-file-truncated');
    } else {
      files[path] = content;
      bytes += data.length;
    }
  };
  const storeDocument = (
    path: string,
    content: string,
    available: number,
  ): void => {
    if (Buffer.byteLength(content) > available) {
      note('virtual-file-truncated');
      content = truncatedDocument;
      if (Buffer.byteLength(content) > available)
        content = available >= 2 ? '{}' : '';
    }
    store(path, content, available);
  };
  const addMeasurement = async (
    ref: string,
    source: JsonObject,
  ): Promise<void> => {
    if (excludedMeasurements.has(ref) || seenMeasurements.has(ref)) return;
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
    if (excludedProducers.has(String(measurement.callId))) return;
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
                    : /\.json$/i.test(file.path) || /^\s*[\[{]/.test(content)
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
    call: EvidenceCall,
    role: string,
    origin: JsonObject = {},
  ): Promise<void> => {
    context.signal?.throwIfAborted();
    const id = string(call.record.callId);
    if (included.has(id)) return;
    included.add(id);
    const path = `context/evolution/calls/${safeId(id)}.json`;
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
          ? call.input.sources.map((raw) => {
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
        sourcesOmitted: 0,
      },
      role,
      path,
      ...origin,
    };
    entries.push(entry);
    await expandReferences(call.input, call.record);
    if (typeof call.output.measurementRef === 'string')
      await addMeasurement(call.output.measurementRef, call.record);
    callFiles.set(call, entry);
  };
  const writeCallFiles = async (
    call: EvidenceCall,
    entry: JsonObject,
  ): Promise<void> => {
    const id = string(call.record.callId);
    const path = string(entry.path);
    const summary: JsonObject = {
      callId: id,
      bindingId: call.record.bindingId ?? null,
      status: call.record.status ?? null,
      path: call.record.path ?? null,
    };
    const selector = String(call.record.contractId).startsWith(
      'contract.selector',
    );
    let record = call.record;
    if (selector) {
      const output = { ...call.output };
      if (!includeTrainingFeedback || restrictedWorkspaces.has(id)) {
        delete output.selectedValue;
        delete output.incumbentValue;
        delete output.candidateValue;
      }
      const fields = [
        'accepted',
        'selectedCandidateRef',
        'decisionRef',
        'selectedValue',
        'incumbentValue',
        'candidateValue',
      ];
      summary.output = Object.fromEntries(
        Object.entries(output).filter(([key]) => fields.includes(key)),
      );
      record = { ...record, output };
    }
    if (withheldSelections.has(id)) {
      record = {
        ...record,
        ...(record.error === undefined
          ? {}
          : { error: 'Held-out delivery details omitted' }),
        output: Object.fromEntries(
          Object.entries(call.output).filter(([key]) =>
            ['candidateRef', 'measurementRef', 'decisionRef'].includes(key),
          ),
        ),
      };
    }
    if (!includeExecutionDetails) record = summary;
    store(path, safeText(record));
    if (typeof call.output.diffRef === 'string')
      await artifactText(
        call.output.diffRef,
        `context/evolution/calls/${id}-patch.json`,
        call.record,
      );
    // A Memory snapshot may quote execution evidence from a different window.
    // Keep its update receipt in training summaries without importing that text.
    if (
      call.record.bindingId === '_memory' &&
      !restrictedWorkspaces.has(id) &&
      options.kind === 'reflection' &&
      includeExecutionDetails &&
      typeof call.output.resourceRef === 'string'
    )
      await artifactText(
        call.output.resourceRef,
        `context/evolution/calls/${id}-memory`,
        call.record,
      );
    if (
      !includeExecutionDetails ||
      options.kind !== 'reflection' ||
      restrictedWorkspaces.has(id)
    )
      return;
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
      const childPath = `context/evolution/calls/${id}-descendant-${safeId(childId)}.json`;
      store(childPath, safeText(child.record));
      try {
        const diagnostic = await readAgentTrace(
          join(
            options.directory,
            'experiments',
            safeId(context.experimentId),
            'calls',
            safeId(childId),
            ...(typeof child.record.attemptId === 'string'
              ? ['attempts', safeId(child.record.attemptId)]
              : []),
          ),
        );
        store(
          `context/evolution/calls/${id}-trace-${childId}.jsonl`,
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
    for (const child of calls) {
      const childId = String(child.record.callId);
      const ref = child.record.agentProjectArtifactRef;
      if (
        childId === id ||
        !descendants.has(childId) ||
        typeof ref !== 'string' ||
        !options.isAgentBinding?.(String(child.record.bindingId))
      )
        continue;
      await artifactText(
        ref,
        `context/evolution/calls/${id}-workspace-${safeId(childId)}`,
        child.record,
      );
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
        !matchesPrimary(result.record, options) ||
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
  const pairs = new Map<
    string,
    {
      parent: JsonObject;
      revision: JsonObject;
      bindings: Set<string>;
      callId?: JsonValue;
    }
  >();
  /** Compare observed revision calls and resource contents without claiming causality. */
  const collectRevisionComparisons = async (): Promise<JsonObject[]> => {
    const comparisons: JsonObject[] = [];
    const ownedBy = (revision: JsonObject, binding: string): boolean =>
      Array.isArray(revision.bindings)
        ? revision.bindings.includes(binding)
        : revision.binding === binding;
    for (const binding of new Set(
      options.observe.bindings ??
        selected.map((call) => String(call.record.bindingId)),
    )) {
      if (options.observe.excludeBindings?.includes(binding)) continue;
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
        revision.ref !== currentRef ||
        revision.experimentId !== context.experimentId ||
        !ownedBy(revision, binding)
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
        parent.ref !== revision.parentRef ||
        parent.experimentId !== context.experimentId ||
        parent.rootRef !== revision.rootRef ||
        !ownedBy(parent, binding)
      ) {
        note(
          'parent-revision-comparison-ownership-unavailable',
          currentCall?.record.callId,
        );
        continue;
      }
      // A joint parent may only have reloaded a different binding. Receipts
      // keep the last version actually activated for this particular binding.
      let priorVersion = parent;
      const visited = new Set<string>();
      while (
        Array.isArray(priorVersion.changedBindings) &&
        priorVersion.kind !== 'initial' &&
        !priorVersion.changedBindings.includes(binding) &&
        typeof priorVersion.parentRef === 'string'
      ) {
        const ref = priorVersion.parentRef;
        if (visited.has(ref))
          throw new Error('Cyclic revision ancestry: ' + ref);
        visited.add(ref);
        const earlier = await context.facts.read('revisions', ref);
        if (
          earlier.ref !== ref ||
          earlier.rootRef !== parent.rootRef ||
          earlier.experimentId !== context.experimentId ||
          !ownedBy(earlier, binding)
        )
          throw new Error('Invalid binding ancestry for revision: ' + ref);
        priorVersion = earlier;
      }
      const priorCalls = (currentCall ? calls : bindingCalls).filter(
        (call) =>
          matchesPrimary(call.record, options) &&
          call.record.bindingId === binding &&
          (call.record.revisionRef === priorVersion.ref ||
            (call.record.revisionRef == null &&
              priorVersion.kind === 'initial')) &&
          (!currentCall ||
            finished(call.record) <= finished(currentCall.record)),
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
      const pair = pairs.get(currentRef) ?? {
        parent,
        revision,
        bindings: new Set<string>(),
        callId: currentCall?.record.callId,
      };
      pair.bindings.add(binding);
      pairs.set(currentRef, pair);
    }

    return comparisons;
  };
  const writeRevisionFiles = async (): Promise<void> => {
    // A shared revision contributes one patch covering the members authorized in this window.
    for (const { parent, revision, bindings, callId } of pairs.values()) {
      const contents = async (
        record: JsonObject,
      ): Promise<Map<string, { text: string; mode: number }> | undefined> => {
        if (
          typeof record.resourceRef !== 'string' ||
          typeof record.ref !== 'string'
        ) {
          note('historical-resource-unavailable', callId);
          return;
        }
        const scopes =
          record.sourceRoots === undefined
            ? [...bindings].map((binding) => ({
                path: `bindings/${binding}/resources`,
                directory: true,
              }))
            : parseCoveringRoots(record.sourceRoots).flatMap((root) =>
                root.members
                  .filter((member) => bindings.has(member.binding))
                  .map((member) => ({
                    path: memberPath(root, member),
                    directory: member.kind === 'directory',
                  })),
              );
        const tree = parseFileTree(
          await context.artifacts.readJson(record.resourceRef),
        );
        const entries = new Map<string, { text: string; mode: number }>();
        for (const { path, mode, base64 } of tree.files) {
          if (
            !scopes.some(
              (scope) =>
                scope.path === path ||
                (scope.directory && path.startsWith(scope.path + '/')),
            )
          )
            continue;
          let text: string;
          try {
            text = new TextDecoder('utf8', { fatal: true }).decode(
              Buffer.from(base64, 'base64'),
            );
            const output = `context/evolution/versions/${record.ref}/${path}`;
            if (!Object.hasOwn(files, output))
              store(output, safeText(text, 'text'));
          } catch {
            text = `[uninspected binary resource ${digest(base64)}]`;
            note('binary-resource-content-uninspected', callId);
          }
          entries.set(path, { text, mode });
        }
        return entries;
      };
      const oldFiles = await contents(parent);
      const newFiles = await contents(revision);
      if (oldFiles && newFiles) {
        const patches: string[] = [];
        for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
          const before = oldFiles.get(path),
            after = newFiles.get(path);
          const oldText = before?.text,
            newText = after?.text;
          if (oldText === newText && before?.mode === after?.mode) continue;
          if (
            typeof before?.mode === 'number' &&
            typeof after?.mode === 'number' &&
            before.mode !== after.mode
          )
            patches.push(
              `old mode ${before.mode.toString(8)}\nnew mode ${after.mode.toString(8)}`,
            );
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
          `context/evolution/versions/${revision.ref}-difference.patch`,
          safeText(patches.join('\n'), 'text'),
        );
      }
    }
  };
  const comparisons =
    options.kind === 'reflection' ? await collectRevisionComparisons() : [];
  if (measurements.length && includeTrainingFeedback) {
    const quota = Math.min(
      detailLimit,
      includeExecutionDetails ? Math.floor(limit * 0.4) : detailLimit,
    );
    // Tiny envelopes still need a valid omission marker. Avoid projecting into a
    // budget smaller than the JSON protocol header.
    const feedback = await projectEvidence({
      measurements,
      artifacts: context.artifacts,
      view: 'training-summary',
      includeExecutionPreviews: !includeExecutionDetails,
      maxBytes: Number.isFinite(quota) ? Math.max(256, quota) : undefined,
    });
    storeDocument(
      'context/evolution/training-summary.json',
      canonical(feedback),
      quota,
    );
  }
  if (options.observe.includeCandidateDiffs) {
    const comparisonReserve = Number.isFinite(limit)
      ? Math.floor((detailLimit - bytes) / 2)
      : 0;
    await projectCandidateEvidence(
      context,
      selected,
      options.observe.includeBaseline ?? false,
      (path, content) => {
        if (path === 'context/evolution/comparisons.json')
          storeDocument(path, content, detailLimit - bytes);
        else store(path, content, detailLimit - bytes - comparisonReserve);
      },
      withheldSelections,
    );
  }
  for (const [call, entry] of callFiles) await writeCallFiles(call, entry);
  await writeRevisionFiles();
  const sources: JsonObject[] = [];
  const sourceDescriptors = new Map<string, JsonObject>();
  if (measurements.length && includeExecutionDetails) {
    const projected = await projectEvidenceFiles({
      measurements,
      artifacts: context.artifacts,
      view: 'execution',
      directory: 'context/evolution/evidence',
    });
    if (options.kind === 'memory') {
      const packets = executionEvidencePackets(
        projected,
        'context/evolution/packets',
      );
      for (const [path, text] of Object.entries(packets.files))
        store(path, string(text));
      store('context/evolution/packets/index.json', safeText(packets.evidence));
    }
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
                  `Runtime evolution evidence file ${file.path}: expected text`,
                );
              store(file.path, content);
              sourceTextPaths.set(sourceKey, file.path);
            }
          }
          if (
            file.inspection !== 'uninspected' ||
            options.kind !== 'reflection'
          )
            continue;
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
      'context/evolution/evaluation-index.json',
      safeText({ ...projected, files: {} }),
    );
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
  // The wrapper in evolutionContext adds a fixed digest ref, indexes and previews.
  // Keeping this space lets constrained projects retain the same parseable index.
  const indexBudget = Math.max(0, limit - bytes - wrapperBytes);
  storeDocument('context/evolution/index.json', safeText(index), indexBudget);
  const payload: JsonObject = {
    experimentId: context.experimentId,
    policyScopeId,
    moduleKind: options.kind,
    configDigest: options.configDigest ?? null,
    measurementRefs: [...seenMeasurements],
    index,
    files,
    sources,
    view: 'evolution-observations/v1',
    evidenceView: view,
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
  await persistFact(context.facts, 'evidence-views', ref, payload);
  return {
    ref,
    callCount: selected.length + lateResults.length,
    callIds: primaryIds,
  };
}

function safeText(
  value: JsonValue,
  format: 'json' | 'text' | 'jsonl' = 'json',
): string {
  return fullEvidenceText(
    typeof value === 'string' ? value : canonical(value),
    format,
  ).text;
}
