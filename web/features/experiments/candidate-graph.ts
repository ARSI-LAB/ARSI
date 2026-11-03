import type { CandidateSummary } from '../../api/observation-client.js';

export interface CandidateNode {
  ref: string;
  parentRef: string | null;
  missing: boolean;
  outside: boolean;
  x: number;
  y: number;
}
export interface CandidateGraph {
  nodes: CandidateNode[];
  edges: { source: string; target: string }[];
  cyclic: boolean;
  shown: number;
  total: number;
  width: number;
  height: number;
}
export const nodeWidth = 220;
export const nodeHeight = 94;

/** Lay out recorded edges only. Missing parents are explicit placeholders, never inferred roots. */
export function candidateGraph(
  candidates: readonly CandidateSummary[],
  selected?: string,
  limit = 150,
): CandidateGraph {
  const all = new Map(candidates.map((item) => [item.ref, item]));
  const displayed = candidates.slice(0, limit);
  const focus = selected ? all.get(selected) : undefined;
  if (focus && !displayed.some((item) => item.ref === focus.ref))
    displayed.splice(Math.max(0, displayed.length - 1), 1, focus);
  const nodes = new Map<string, CandidateNode>();
  for (const item of displayed)
    nodes.set(item.ref, {
      ref: item.ref,
      parentRef: item.parentRef,
      missing: false,
      outside: false,
      x: 0,
      y: 0,
    });
  for (const item of displayed)
    if (item.parentRef && !nodes.has(item.parentRef))
      nodes.set(item.parentRef, {
        ref: item.parentRef,
        parentRef: null,
        missing: true,
        outside: all.has(item.parentRef),
        x: 0,
        y: 0,
      });
  const depths = new Map<string, number>();
  let cyclic = false;
  for (const start of nodes.keys()) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let cursor: string | null = start;
    while (cursor !== null && !depths.has(cursor)) {
      const cycleStart = seen.get(cursor);
      if (cycleStart !== undefined) {
        cyclic = true;
        for (const ref of path.slice(cycleStart)) depths.set(ref, 0);
        break;
      }
      seen.set(cursor, path.length);
      path.push(cursor);
      cursor = nodes.get(cursor)?.parentRef ?? null;
    }
    for (const ref of path.reverse())
      if (!depths.has(ref)) {
        const parent = nodes.get(ref)?.parentRef;
        depths.set(ref, parent ? (depths.get(parent) ?? 0) + 1 : 0);
      }
  }
  const levels = new Map<number, number>();
  for (const node of nodes.values()) {
    const depth = depths.get(node.ref) ?? 0;
    const row = levels.get(depth) ?? 0;
    node.x = 24 + depth * 284;
    node.y = 24 + row * 124;
    levels.set(depth, row + 1);
  }
  const values = [...nodes.values()];
  return {
    nodes: values,
    edges: displayed.flatMap((item) =>
      item.parentRef ? [{ source: item.parentRef, target: item.ref }] : [],
    ),
    cyclic,
    shown: displayed.length,
    total: candidates.length,
    width: Math.max(
      280,
      ...values.map((item) => item.x + nodeWidth + (cyclic ? 144 : 24)),
    ),
    height: Math.max(180, ...values.map((item) => item.y + nodeHeight + 24)),
  };
}
