import { parseArtifact, type Page } from '../../api/observation-client.js';
export interface RecordedFile {
  path: string;
  bytes: number;
}
export interface FileEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  bytes: number;
  files: number;
}
export function parseArtifactFiles(raw: unknown): Page<RecordedFile> {
  return parseArtifact(raw).files ?? { items: [], total: 0, nextOffset: null };
}
export function parentDirectory(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}
/** Search covers the complete loaded index; directory browsing respects path segment boundaries. */
export function fileEntries(
  files: readonly RecordedFile[],
  directory: string,
  search: string,
): FileEntry[] {
  const query = search.trim().toLowerCase();
  if (query)
    return files
      .filter((file) => file.path.toLowerCase().includes(query))
      .map((file) => ({ ...file, name: file.path, kind: 'file', files: 1 }));
  const prefix = directory ? directory + '/' : '';
  const entries = new Map<string, FileEntry>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (!rest) continue;
    const name = rest.split('/')[0]!;
    const path = prefix + name;
    const entry = entries.get(path) ?? {
      path,
      name,
      kind: rest.includes('/') ? 'directory' : 'file',
      bytes: 0,
      files: 0,
    };
    entry.bytes += file.bytes;
    entry.files++;
    entries.set(path, entry);
  }
  return [...entries.values()].sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name),
  );
}
