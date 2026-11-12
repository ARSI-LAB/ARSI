interface IterationScope {
  /** Zero-based iteration index in outer-to-inner order. */
  index: number;
  /** Recorded segments following this iteration scope, without rewriting them. */
  suffix: string[];
}

/** Read current iteration-N scopes and historical loop/N scopes; opaque paths have none. */
export function readIterationScopes(
  path: string | null | undefined,
): IterationScope[] {
  const segments = path?.split('/') ?? [];
  const current = segments[0] === 'steps';
  const iterations: IterationScope[] = [];
  for (let position = 0; position < segments.length; position++) {
    // Current paths alternate step IDs and scopes after the initial "steps".
    let digits =
      current && position >= 2 && position % 2 === 0
        ? /^iteration-(\d+)$/.exec(segments[position]!)?.[1]
        : undefined;
    if (
      !current &&
      segments[position] === 'loop' &&
      /^\d+$/.test(segments[position + 1] ?? '')
    ) {
      digits = segments[++position];
    }
    if (digits === undefined) continue;
    const index = Number(digits);
    if (!Number.isSafeInteger(index + 1)) continue;
    iterations.push({ index, suffix: segments.slice(position + 1) });
  }
  return iterations;
}
