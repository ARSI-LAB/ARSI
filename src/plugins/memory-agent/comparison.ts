import type {
  RuntimeContext,
  JsonObject,
  FileTreeFile,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import { memoryComparisonSchema } from '../../contracts/plugin-types/index.js';
import { object, string, strings } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { secretValues, redactText } from '../../shared/secrets.js';
import {
  excerpt,
  executionEvidencePackets,
} from '../shared/agent-editing/evidence-packets.js';
import type { ReadOnlyEditContext } from '../shared/agent-editing/index.js';

interface SnapshotFile extends FileTreeFile {
  text: string | null;
}
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

/** Validate comparison provenance before exposing immutable, read-only snapshots to Memory. */
export async function buildComparisonContext(
  input: JsonObject,
  context: RuntimeContext,
): Promise<ReadOnlyEditContext> {
  const secrets = secretValues();
  const comparison = object(input.comparison);
  validate(memoryComparisonSchema, comparison, 'Memory comparison');
  const groups = object(comparison.probes);
  const probes: JsonObject[] = [];
  for (const [group, raw] of Object.entries(groups)) {
    if (!Array.isArray(raw))
      throw new Error('Comparison probes must be arrays');
    for (const value of raw) probes.push({ ...object(value), group });
  }
  const selected = object(comparison.selection);
  const samePair = (a: JsonObject, b: JsonObject): boolean =>
    a.candidateRef === b.candidateRef && a.measurementRef === b.measurementRef;
  if (!probes.some((p) => samePair(p, selected)))
    throw new Error('Selected result is not in comparison probes');
  const refs = [
    ...new Set([
      ...strings(input.evidenceRefs),
      ...probes.map((p) => string(p.measurementRef)),
    ]),
  ];
  // Experiment ownership is checked in the Runtime before evidence is projected.
  const full = object(
    await context.readEvidence(refs, {
      format: 'files',
      view: 'execution',
    }),
  );
  if (
    full.schemaVersion !== 'rsi.evidence-files/v1' ||
    full.view !== 'execution'
  )
    throw new Error('Comparison requires file-backed execution evidence');
  const { files, evidence } = executionEvidencePackets(full);
  const decisions = object(
    await context.artifacts.readJson(string(selected.decisionRef)),
  );
  if (
    decisions.kind !== 'artifact-decision' ||
    !Array.isArray(decisions.candidates) ||
    !Number.isSafeInteger(decisions.selectedIndex)
  )
    throw new Error('Invalid artifact selection decision');
  const chosen = decisions.candidates[Number(decisions.selectedIndex)];
  if (
    !chosen ||
    !samePair(object(chosen), selected) ||
    decisions.candidates.some(
      (c) => !probes.some((p) => samePair(p, object(c))),
    )
  )
    throw new Error('Selection decision does not match comparison probes');
  const snapshots = new Map<string, SnapshotFile[]>();
  const manifests = new Map<string, JsonObject>();
  const add = (path: string, content: string): void => {
    if (Object.hasOwn(files, path))
      throw new Error('Duplicate comparison context file');
    files[path] = content;
  };
  async function snapshot(ref: string): Promise<SnapshotFile[]> {
    const cached = snapshots.get(ref);
    if (cached) return cached;
    const candidate = await context.readCandidate(ref);
    if (candidate.experimentId !== context.experimentId)
      throw new Error('Comparison candidate belongs to another experiment');
    const tree = parseFileTree(
      await context.artifacts.readJson(candidate.artifactRef),
    );
    const contents: SnapshotFile[] = [];
    for (const f of tree.files) {
      const encoded = f.base64,
        data = Buffer.from(encoded, 'base64');
      let decoded: string | null = null;
      if (!data.includes(0)) {
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } catch {
          /* Keep binary snapshots explicitly uninspected. */
        }
      }
      contents.push({
        path: f.path,
        mode: f.mode,
        text: decoded,
        base64: encoded,
      });
    }
    snapshots.set(ref, contents);
    manifests.set(ref, {
      candidateRef: ref,
      artifactRef: candidate.artifactRef,
    });
    return contents;
  }
  const baselineRef = string(comparison.baselineCandidateRef);
  const baseline = await snapshot(baselineRef);
  const seenMeasurements = new Set<string>();
  for (const probe of probes) {
    const candidateRef = string(probe.candidateRef),
      measurementRef = string(probe.measurementRef);
    await snapshot(candidateRef);
    if (!seenMeasurements.has(measurementRef)) {
      const measurement = await context.readMeasurement(measurementRef);
      if (
        measurement.experimentId !== context.experimentId ||
        measurement.candidateRef !== candidateRef
      )
        throw new Error(
          'Comparison measurement does not belong to the candidate',
        );
      seenMeasurements.add(measurementRef);
    } else {
      const other = probes.find((p) => p.measurementRef === measurementRef);
      if (other?.candidateRef !== candidateRef)
        throw new Error(
          'Comparison measurement assigned to different candidates',
        );
    }
  }
  const baselineFiles = new Map(baseline.map((f) => [f.path, f]));
  const diffBudget = Math.max(512, Math.floor(24000 / snapshots.size));
  for (const [ref, current] of snapshots) {
    const currentFiles = new Map(current.map((f) => [f.path, f]));
    const changes: JsonObject[] = [];
    let diff = '';
    for (const path of [
      ...new Set([...baselineFiles.keys(), ...currentFiles.keys()]),
    ].sort()) {
      const before = baselineFiles.get(path),
        after = currentFiles.get(path);
      if (before?.base64 === after?.base64 && before?.mode === after?.mode)
        continue;
      const binary =
        (before && before.text === null) || (after && after.text === null);
      changes.push({
        path,
        kind: !before ? 'added' : !after ? 'deleted' : 'modified',
        beforeMode: before?.mode ?? null,
        afterMode: after?.mode ?? null,
        binary: Boolean(binary),
      });
      const mode = (file: SnapshotFile): string =>
        `100${(file.mode & 0o777).toString(8).padStart(3, '0')}`;
      diff += `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\n`;
      if (!before && after) diff += `new file mode ${mode(after)}\n`;
      else if (before && !after) diff += `deleted file mode ${mode(before)}\n`;
      else if (before && after && before.mode !== after.mode)
        diff += `old mode ${mode(before)}\nnew mode ${mode(after)}\n`;
      diff += binary
        ? `Binary file changed: ${JSON.stringify(path)}\n`
        : patch(path, before?.text ?? null, after?.text ?? null);
    }
    const manifest = manifests.get(ref)!;
    const path = `context/diffs/${[...manifests.keys()].indexOf(ref)}.diff`;
    const projected = redactText(diff, secrets);
    if (Buffer.byteLength(projected) > diffBudget) add(path, projected);
    manifest.diff = excerpt(projected, diffBudget);
    manifest.diffPath = Buffer.byteLength(projected) > diffBudget ? path : null;
    manifest.diffTruncated = Buffer.byteLength(projected) > diffBudget;
    manifest.diffRedacted = projected !== diff;
    manifest.changes = changes;
  }
  const summary: JsonObject = {
    baseline: manifests.get(baselineRef)!,
    candidates: [...manifests.values()],
    probes,
    selectedCandidateRef: selected.candidateRef,
    selectedMeasurementRef: selected.measurementRef,
    decisionRef: selected.decisionRef,
    selectionReason:
      typeof decisions.reason === 'string'
        ? redactText(decisions.reason, secrets)
        : null,
    selectionMeaning:
      'selected deliverable; not a verdict that every harness edit helped',
  };
  const compactCandidates = [...manifests.values()].map((candidate) => ({
    candidateRef: candidate.candidateRef!,
    artifactRef: candidate.artifactRef!,
    diff: candidate.diff!,
    diffPath: candidate.diffPath!,
    diffTruncated: candidate.diffTruncated!,
    diffRedacted: candidate.diffRedacted!,
    changes: candidate.changes!,
  }));
  return {
    files,
    evidence,
    input: {
      comparison: {
        ...summary,
        baseline: {
          candidateRef: baselineRef,
          artifactRef: manifests.get(baselineRef)!.artifactRef!,
        },
        candidates: compactCandidates,
      },
      readOnlyContext:
        'Read inline comparison/evidence first; context/ files are optional supplementary excerpts, not a mandatory reading list.',
    },
  };
}
