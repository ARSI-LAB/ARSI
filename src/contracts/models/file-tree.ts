import type { JsonObject } from '../json.js';
import { object, string } from '../../shared/json.js';

export interface FileTreeFile extends JsonObject {
  path: string;
  mode: number;
  base64: string;
}

export interface FileTreeArtifact extends JsonObject {
  kind: 'file-tree';
  files: FileTreeFile[];
}

/** Validate the shared artifact format without reading or writing filesystem paths. */
export function parseFileTree(value: unknown): FileTreeArtifact {
  const tree = object(value, 'file tree');
  if (tree.kind !== 'file-tree' || !Array.isArray(tree.files))
    throw new Error('Expected file tree');
  const seen = new Set<string>();
  const files = tree.files.map((raw): FileTreeFile => {
    const file = object(raw, 'file tree entry');
    const path = string(file.path, 'file path');
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(`Invalid artifact file path: ${path}`);
    if (seen.has(path))
      throw new Error(`Duplicate artifact file path: ${path}`);
    seen.add(path);
    const mode = file.mode;
    if (
      typeof mode !== 'number' ||
      !Number.isInteger(mode) ||
      mode < 0 ||
      mode > 0o777
    )
      throw new Error(`Invalid artifact file mode: ${path}`);
    const base64 = file.base64;
    if (
      typeof base64 !== 'string' ||
      Buffer.from(base64, 'base64').toString('base64') !== base64
    )
      throw new Error(`Invalid artifact file bytes: ${path}`);
    return { path, mode, base64 };
  });
  return { kind: 'file-tree', files };
}
