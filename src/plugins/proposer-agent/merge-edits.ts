import { diff3Merge } from 'node-diff3';
import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';

const maxContentBytes = 128 * 1024;
// Bound worst-case line comparisons across all pairwise and accumulated merges.
const maxMergeWork = 8_000_000;

type MergeResult = { lines: string[] } | { conflict: string };

function lines(content: string): string[] {
  // Keep terminators in their lines, including CRLF and a missing final newline.
  return content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

/** Reconcile schema-validated edits using the original, editable parent snapshot. */
export function mergeEdits(
  result: JsonObject,
  parentFiles: JsonObject,
): JsonObject {
  if (!Array.isArray(result.edits) || result.edits.length > 32)
    throw new Error('Expected bounded edits array');
  const groups = new Map<string, (string | null)[]>();
  // Complete validation before conflict fallback so invalid edits still fail.
  for (const raw of result.edits) {
    const edit = object(raw);
    const path = string(edit.path);
    if (
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid edit path');
    const content = edit.content;
    if (content !== null && typeof content !== 'string')
      throw new Error('Invalid edit content');
    if (content !== null && Buffer.byteLength(content) > maxContentBytes)
      throw new Error('Resource edit exceeds byte limit');
    const group = groups.get(path) ?? [];
    group.push(content);
    groups.set(path, group);
  }

  let remainingWork = maxMergeWork;
  const combine = (
    left: string[],
    base: string[],
    right: string[],
  ): MergeResult => {
    const work = (base.length + 1) * (left.length + right.length + 2);
    if (work > remainingWork) return { conflict: 'merge work limit exceeded' };
    remainingWork -= work;
    const blocks = diff3Merge(left, base, right, {
      excludeFalseConflicts: true,
    });
    if (blocks.some((block) => block.conflict))
      return { conflict: 'overlapping changes' };
    return { lines: blocks.flatMap((block) => block.ok ?? []) };
  };

  const edits: JsonObject[] = [];
  const conflicts: string[] = [];
  for (const [path, contents] of groups) {
    if (contents.length === 1) {
      edits.push({ path, content: contents[0] });
      continue;
    }
    const base = Object.hasOwn(parentFiles, path) ? parentFiles[path] : null;
    if (base !== null && typeof base !== 'string')
      throw new Error(`Invalid parent file content: ${path}`);
    const changed = [...new Set(contents)].filter(
      (content) => content !== base,
    );
    if (changed.length === 0) continue;
    if (changed.length === 1) {
      edits.push({ path, content: changed[0] });
      continue;
    }
    if (base === null || changed.includes(null)) {
      conflicts.push(
        `${path} (${base === null ? 'different new-file additions' : 'delete/modify conflict'})`,
      );
      continue;
    }
    if (Buffer.byteLength(base) > maxContentBytes) {
      conflicts.push(`${path} (parent exceeds merge byte limit)`);
      continue;
    }

    const original = lines(base);
    const variants = changed
      .filter((content): content is string => content !== null)
      .sort()
      .map(lines);
    let conflict: string | undefined;
    // Accumulation alone can conceal incompatible subsets in later variants.
    // Check every original pair before merging into a fixed-base accumulator.
    pairwise: for (let left = 0; left < variants.length; left++) {
      for (let right = left + 1; right < variants.length; right++) {
        const merged = combine(variants[left], original, variants[right]);
        if ('conflict' in merged) {
          conflict = merged.conflict;
          break pairwise;
        }
      }
    }
    let accumulated = variants[0];
    for (let index = 1; !conflict && index < variants.length; index++) {
      const merged = combine(accumulated, original, variants[index]);
      if ('conflict' in merged) conflict = merged.conflict;
      else accumulated = merged.lines;
    }
    if (conflict) {
      conflicts.push(`${path} (${conflict})`);
      continue;
    }
    const content = accumulated.join('');
    if (Buffer.byteLength(content) > maxContentBytes) {
      conflicts.push(`${path} (merged content exceeds byte limit)`);
      continue;
    }
    edits.push({ path, content });
  }

  if (conflicts.length)
    return {
      edits: [],
      reason: `Duplicate edit conflicts: ${conflicts.join(', ')}. Retained the parent for the whole proposal. Original reason: ${result.reason}`,
    };
  return { edits, reason: result.reason };
}
