import type {
  Candidate,
  FileTreeFile,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import type { LearningObserve } from './schema.js';
import { parseFileTree } from '../../contracts/index.js';
import { canonical, object, string } from '../../shared/json.js';
import { secretValues, redactText } from '../../shared/secrets.js';
import { excerpt } from '../services/facts/evidence-packets.js';
import { safeId } from '../storage/index.js';
import type { EvidenceCall } from './evidence-window.js';

const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** A single exact hunk per changed region; avoids a runtime dependency on Git or quadratic LCS. */
function patch(
  path: string,
  before: string | null,
  after: string | null,
): string {
  if (before === after) return '';
  const a = lines(before ?? ''),
    b = lines(after ?? '');
  if (!a.length && !b.length) return '';
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const start = Math.max(0, prefix - 3),
    endA = Math.min(a.length, a.length - suffix + 3),
    endB = Math.min(b.length, b.length - suffix + 3);
  const render = (mark: string, value: string): string =>
    mark +
    value +
    (value.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  const header = (name: string): string =>
    /[\t\n"\\ ]/.test(name) ? JSON.stringify(name) : name;
  let result = `--- ${before === null ? '/dev/null' : header('a/' + path)}\n+++ ${after === null ? '/dev/null' : header('b/' + path)}\n@@ -${endA === start ? start : start + 1},${endA - start} +${endB === start ? start : start + 1},${endB - start} @@\n`;
  for (const value of a.slice(start, prefix)) result += render(' ', value);
  for (const value of a.slice(prefix, a.length - suffix))
    result += render('-', value);
  for (const value of b.slice(prefix, b.length - suffix))
    result += render('+', value);
  for (const value of a.slice(a.length - suffix, endA))
    result += render(' ', value);
  return result;
}

type Snapshot = { candidate: Candidate; files: Map<string, FileTreeFile> };

function textFile(file: FileTreeFile): string | null {
  const bytes = Buffer.from(file.base64, 'base64');
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function diffTrees(before: Snapshot, after: Snapshot): string {
  let result = '';
  for (const path of [
    ...new Set([...before.files.keys(), ...after.files.keys()]),
  ].sort()) {
    const a = before.files.get(path);
    const b = after.files.get(path);
    if (a?.base64 === b?.base64 && a?.mode === b?.mode) continue;
    result += `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\n`;
    const mode = (file: FileTreeFile) =>
      `100${(file.mode & 0o777).toString(8).padStart(3, '0')}`;
    if (a && b && a.mode !== b.mode)
      result += `old mode ${mode(a)}\nnew mode ${mode(b)}\n`;
    else if (!a && b) result += `new file mode ${mode(b)}\n`;
    else if (a && !b) result += `deleted file mode ${mode(a)}\n`;
    const aText = a ? textFile(a) : null;
    const bText = b ? textFile(b) : null;
    result +=
      (a && aText === null) || (b && bText === null)
        ? `Binary file changed: ${JSON.stringify(path)}\n`
        : patch(path, aText, bText);
  }
  return result;
}

async function artifactDecision(
  context: RuntimeContext,
  call: EvidenceCall,
  secrets: string[],
  withholdReason: boolean,
): Promise<JsonObject> {
  const ref = string(call.output.decisionRef);
  const decision = object(await context.artifacts.readJson(ref));
  if (
    decision.kind !== 'artifact-decision' ||
    !Array.isArray(decision.candidates) ||
    !Number.isSafeInteger(decision.selectedIndex) ||
    !Array.isArray(call.input.candidates)
  )
    throw new Error('Invalid artifact selection decision');
  const source = call.input.candidates;
  const used = new Set<number>();
  const candidates = decision.candidates.map((raw) => {
    const candidate = object(raw);
    const index = candidate.originalIndex;
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= source.length ||
      used.has(index)
    )
      throw new Error('Invalid artifact selection candidate index');
    used.add(index);
    const supplied = object(source[index]);
    if (
      supplied.candidateRef !== candidate.candidateRef ||
      supplied.measurementRef !== candidate.measurementRef
    )
      throw new Error(
        'Artifact selection does not match the observed candidates',
      );
    return {
      candidateRef: string(candidate.candidateRef),
      measurementRef: string(candidate.measurementRef),
    };
  });
  const chosen = candidates[Number(decision.selectedIndex)];
  if (
    used.size !== source.length ||
    !chosen ||
    chosen.candidateRef !== call.output.candidateRef ||
    chosen.measurementRef !== call.output.measurementRef
  )
    throw new Error('Artifact selection does not match the observed result');
  return {
    callId: call.record.callId!,
    decisionRef: ref,
    selectedCandidateRef: chosen.candidateRef,
    selectedMeasurementRef: chosen.measurementRef,
    candidates,
    selectionReason: withholdReason
      ? null
      : redactText(string(decision.reason), secrets),
  };
}

/** Project only candidates referenced by selected calls and their explicit diff anchors. */
export async function projectCandidateEvidence(
  context: RuntimeContext,
  selected: readonly EvidenceCall[],
  observe: LearningObserve,
  store: (path: string, content: string) => void,
  withheldSelections: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!observe.includeCandidateDiffs && !observe.includeCandidateSources)
    return;
  const refs = new Set<string>();
  const evaluations: JsonObject[] = [];
  const selections: JsonObject[] = [];
  const secrets = secretValues();
  for (const call of selected) {
    for (const ref of [
      call.input.parent,
      call.input.candidateRef,
      call.output.candidateRef,
    ])
      if (typeof ref === 'string') refs.add(ref);
    if (Array.isArray(call.output.candidates))
      for (const candidate of call.output.candidates) {
        const ref = object(candidate).candidateRef;
        if (typeof ref === 'string') refs.add(ref);
      }
    if (
      typeof call.input.candidateRef === 'string' &&
      typeof call.output.measurementRef === 'string'
    ) {
      const measurement = await context.readMeasurement(
        call.output.measurementRef,
      );
      if (
        measurement.experimentId !== context.experimentId ||
        measurement.candidateRef !== call.input.candidateRef
      )
        throw new Error(
          'Observed measurement does not belong to the candidate',
        );
      evaluations.push({
        bindingId: call.record.bindingId!,
        stepPath: call.record.path!,
        candidateRef: call.input.candidateRef,
        measurementRef: call.output.measurementRef,
      });
    }
    if (
      observe.includeCandidateDiffs &&
      call.record.pluginId === 'selector.artifact' &&
      call.output.decisionRef
    )
      selections.push(
        await artifactDecision(
          context,
          call,
          secrets,
          withheldSelections.has(string(call.record.callId)),
        ),
      );
  }
  const baseline =
    refs.size && observe.includeBaseline
      ? (await context.applicationMetadata()).initialCandidateRef
      : null;
  if (typeof baseline === 'string') refs.add(baseline);
  const snapshots = new Map<string, Snapshot>();
  async function snapshot(ref: string): Promise<Snapshot> {
    const cached = snapshots.get(ref);
    if (cached) return cached;
    const candidate = await context.readCandidate(ref);
    if (candidate.experimentId !== context.experimentId)
      throw new Error('Observed candidate belongs to another experiment');
    const artifact = await context.artifacts.readJson(candidate.artifactRef);
    const files =
      artifact &&
      typeof artifact === 'object' &&
      !Array.isArray(artifact) &&
      artifact.kind === 'file-tree'
        ? parseFileTree(artifact).files
        : [
            {
              path: 'candidate.json',
              mode: 0o644,
              base64: Buffer.from(canonical(artifact)).toString('base64'),
            },
          ];
    const value = {
      candidate,
      files: new Map(files.map((file) => [file.path, file])),
    };
    snapshots.set(ref, value);
    return value;
  }
  const candidates: JsonObject[] = [];
  let difference = 0;
  const inlineLimit = Math.max(512, Math.floor(24000 / Math.max(1, refs.size)));
  for (const ref of refs) {
    context.signal.throwIfAborted();
    const current = await snapshot(ref);
    if (observe.includeCandidateSources)
      for (const file of current.files.values()) {
        const content = textFile(file);
        if (content !== null)
          store(
            `context/learning/candidates/${safeId(ref)}/${file.path}`,
            redactText(content, secrets),
          );
      }
    const { artifactRef, parentRef } = current.candidate;
    const diffs: JsonObject[] = [];
    if (observe.includeCandidateDiffs)
      for (const against of new Set([parentRef, baseline])) {
        if (typeof against !== 'string' || against === ref) continue;
        const delta = redactText(
          diffTrees(await snapshot(against), current),
          secrets,
        );
        const path =
          Buffer.byteLength(delta) > inlineLimit
            ? `context/learning/diffs/${difference++}.diff`
            : null;
        if (path) store(path, delta);
        diffs.push({ against, path, preview: excerpt(delta, inlineLimit) });
      }
    candidates.push({ candidateRef: ref, artifactRef, parentRef, diffs });
  }
  store(
    'context/learning/comparisons.json',
    canonical({ candidates, evaluations, selections }),
  );
}
