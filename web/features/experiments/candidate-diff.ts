import {
  readObservation,
  parseArtifact,
  type ArtifactPreview,
} from '../../api/observation-client.js';
import { readAllObservationPages } from '../../api/read-all-pages.js';
import type { RecordedFile } from './file-browser-model.js';

export interface TextChange {
  path: string;
  kind: 'added' | 'removed' | 'modified' | 'unavailable';
  before: string | null;
  after: string | null;
  reason?: string;
}
export interface CandidateDiff {
  changes: TextChange[];
  unchanged: number;
  total: number;
}
function fileIndex(raw: unknown) {
  const value = parseArtifact(raw);
  if (value.kind !== 'file-tree' || !value.files)
    throw new Error('Text comparison requires two recorded file trees.');
  return value.files;
}
function textProblem(value: ArtifactPreview | null): string | null {
  if (value === null) return null;
  if (value.unavailable) return value.unavailable;
  if (!value.content) return 'Text was not recorded.';
  if (value.content.truncated)
    return 'Preview is truncated; a complete text comparison is unavailable.';
  if (value.content.text.includes('[REDACTED]'))
    return 'Redacted text cannot establish a complete comparison.';
  return null;
}
/** Compare immutable public text previews only. Unknown/binary/restricted files never count as unchanged. */
async function readCandidateDiff(
  id: string,
  parent: string,
  current: string,
  signal: AbortSignal,
): Promise<CandidateDiff> {
  const base = `/${encodeURIComponent(id)}/artifacts/`;
  const [beforeIndex, afterIndex] = await Promise.all(
    [parent, current].map((ref) =>
      readAllObservationPages(
        base + encodeURIComponent(ref),
        fileIndex,
        signal,
      ),
    ),
  );
  const before = new Map(
    beforeIndex!.items.map((file: RecordedFile) => [file.path, file]),
  );
  const after = new Map(
    afterIndex!.items.map((file: RecordedFile) => [file.path, file]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  if (paths.length > 128)
    throw new Error(
      'Text comparison supports up to 128 files. The complete snapshot remains available in Full files.',
    );
  const changes: (TextChange | null)[] = new Array(paths.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (cursor < paths.length) {
        signal.throwIfAborted();
        const index = cursor++,
          path = paths[index]!;
        const oldDigest = before.get(path)?.digest;
        if (oldDigest && oldDigest === after.get(path)?.digest) {
          changes[index] = null;
          continue;
        }
        const read = (ref: string) =>
          readObservation(
            `${base}${encodeURIComponent(ref)}?${new URLSearchParams({ path })}`,
            parseArtifact,
            signal,
          );
        const [left, right] = await Promise.all([
          before.has(path) ? read(parent) : null,
          after.has(path) ? read(current) : null,
        ]);
        const reason = textProblem(left) ?? textProblem(right);
        const oldText = left?.content?.text ?? null,
          newText = right?.content?.text ?? null;
        changes[index] = reason
          ? { path, kind: 'unavailable', before: null, after: null, reason }
          : !before.has(path)
            ? { path, kind: 'added', before: null, after: newText }
            : !after.has(path)
              ? { path, kind: 'removed', before: oldText, after: null }
              : oldText !== newText
                ? { path, kind: 'modified', before: oldText, after: newText }
                : null;
      }
    }),
  );
  return {
    changes: changes.filter((change): change is TextChange => change !== null),
    unchanged: changes.filter((change) => change === null).length,
    total: paths.length,
  };
}
/** Abort sibling reads on failure as well as when the view is left. */
export async function loadCandidateDiff(
  id: string,
  parent: string,
  current: string,
  signal: AbortSignal,
): Promise<CandidateDiff> {
  const controller = new AbortController();
  try {
    return await readCandidateDiff(
      id,
      parent,
      current,
      AbortSignal.any([signal, controller.signal]),
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
}
export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
  before: number | null;
  after: number | null;
}
/** One contiguous replacement with three context lines; exact text is preserved without a quadratic diff. */
export function changedLines(
  before: string | null,
  after: string | null,
): DiffLine[] {
  const left = before === null ? [] : before.split('\n'),
    right = after === null ? [] : after.split('\n');
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  if (prefix === left.length && prefix === right.length) return [];
  const lines: DiffLine[] = [];
  for (let index = Math.max(0, prefix - 3); index < prefix; index++)
    lines.push({
      kind: 'context',
      text: left[index]!,
      before: index + 1,
      after: index + 1,
    });
  for (let index = prefix; index < left.length - suffix; index++)
    lines.push({
      kind: 'removed',
      text: left[index]!,
      before: index + 1,
      after: null,
    });
  for (let index = prefix; index < right.length - suffix; index++)
    lines.push({
      kind: 'added',
      text: right[index]!,
      before: null,
      after: index + 1,
    });
  for (let index = 0; index < Math.min(3, suffix); index++)
    lines.push({
      kind: 'context',
      text: left[left.length - suffix + index]!,
      before: left.length - suffix + index + 1,
      after: right.length - suffix + index + 1,
    });
  return lines;
}
