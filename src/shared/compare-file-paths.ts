/** Persisted digests need the same path order in every locale. */
export function compareFilePaths(
  a: { path: string },
  b: { path: string },
): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}
