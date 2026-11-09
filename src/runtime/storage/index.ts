import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  lstat,
  chmod,
  rm,
  link,
} from 'node:fs/promises';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactStore,
  FactStore,
  JsonObject,
  JsonValue,
  Workspace,
  WorkspaceService,
  FileTreeFile,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import { canonical, digest, object, string, json } from '../../shared/json.js';

export const excludedArtifactEntries: readonly string[] = [
  'node_modules',
  '.git',
  '__pycache__',
];

export function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Error(`Unsafe identifier ${id}`);
  return id;
}
export function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const local = relative(root, target);
  if (isAbsolute(local) || local === '..' || local.startsWith('../'))
    throw new Error(`Path escapes workspace: ${path}`);
  return target;
}
export async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temp, canonical(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    published = true;
  } finally {
    // Rename consumes the temporary path; a confirmed publication needs no cleanup.
    if (!published) await rm(temp, { force: true });
  }
}

export class FileArtifacts implements ArtifactStore {
  constructor(readonly directory: string) {}
  private path(ref: string): string {
    if (!/^artifact:[a-f0-9]{64}$/.test(ref))
      throw new Error('Invalid artifact reference');
    return join(this.directory, ref.slice(9) + '.json');
  }
  async putJson(value: unknown): Promise<string> {
    json(value);
    const ref = `artifact:${digest(value)}`;
    const destination = this.path(ref);
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, canonical(value), { flag: 'wx', mode: 0o600 });
      try {
        await link(temp, destination);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
        if (canonical(await this.readJson(ref)) !== canonical(value))
          throw new Error('Artifact collision');
      }
      return ref;
    } finally {
      await rm(temp, { force: true });
    }
  }
  async readJson(ref: string): Promise<JsonValue> {
    const value: unknown = JSON.parse(await readFile(this.path(ref), 'utf8'));
    json(value);
    if (`artifact:${digest(value)}` !== ref)
      throw new Error('Artifact digest mismatch');
    return value;
  }
  async capture(directory: string): Promise<string> {
    const files: FileTreeFile[] = [];
    const walk = async (root: string): Promise<void> => {
      const names = await readdir(root);
      names.sort();
      for (const name of names) {
        if (excludedArtifactEntries.includes(name)) continue;
        const path = join(root, name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error('Symbolic link rejected');
        if (stat.isDirectory()) await walk(path);
        else if (stat.isFile()) {
          files.push({
            path: relative(directory, path).split(sep).join('/'),
            mode: stat.mode & 0o777,
            base64: (await readFile(path)).toString('base64'),
          });
        } else throw new Error('Special file rejected');
      }
    };
    await walk(directory);
    return this.putJson({ kind: 'file-tree', files });
  }
  async materialize(ref: string, directory: string): Promise<void> {
    const tree = parseFileTree(await this.readJson(ref));
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await readdir(directory)).length
    )
      throw new Error('Artifact target must be an empty real directory');
    for (const file of tree.files) {
      const path = inside(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.base64, 'base64'), {
        flag: 'wx',
        mode: file.mode,
      });
      await chmod(path, file.mode);
    }
  }
}
export class FileFacts implements FactStore {
  constructor(readonly directory: string) {}
  private path(kind: string, id: string): string {
    return join(this.directory, safeId(kind), safeId(id) + '.json');
  }
  async read(kind: string, id: string): Promise<JsonObject> {
    return object(JSON.parse(await readFile(this.path(kind, id), 'utf8')));
  }
  async write(kind: string, id: string, value: JsonObject): Promise<void> {
    json(value);
    await atomic(this.path(kind, id), structuredClone(value));
  }
  private async names(kind: string): Promise<string[]> {
    const directory = join(this.directory, safeId(kind));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    }
    return names.filter((n) => n.endsWith('.json')).sort();
  }
  async *scan(kind: string): AsyncGenerator<JsonObject> {
    for (const name of await this.names(kind))
      yield await this.read(kind, name.slice(0, -5));
  }
  async list(kind: string): Promise<JsonObject[]> {
    return Promise.all(
      (await this.names(kind)).map((name) =>
        this.read(kind, name.slice(0, -5)),
      ),
    );
  }
}
export class FileWorkspaces implements WorkspaceService {
  constructor(
    readonly directory: string,
    private readonly artifacts: ArtifactStore,
  ) {}
  async create(
    artifactRef?: string,
    parentCandidateRef?: string,
  ): Promise<Workspace> {
    const ref = randomUUID();
    const directory = join(this.directory, ref, 'files');
    await mkdir(directory, { recursive: true });
    const workspace = {
      ref,
      directory,
      parentCandidateRef: parentCandidateRef ?? null,
    };
    await atomic(join(this.directory, ref, 'workspace.json'), workspace);
    try {
      if (artifactRef) await this.artifacts.materialize(artifactRef, directory);
      return workspace;
    } catch (error) {
      await this.release(ref);
      throw error;
    }
  }
  async read(ref: string): Promise<Workspace> {
    const value = object(
      JSON.parse(
        await readFile(
          join(this.directory, safeId(ref), 'workspace.json'),
          'utf8',
        ),
      ),
    );
    const directory = string(value.directory);
    if (directory !== join(this.directory, ref, 'files'))
      throw new Error('Workspace identity mismatch');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Workspace is not a real directory');
    return {
      ref,
      directory,
      parentCandidateRef:
        typeof value.parentCandidateRef === 'string'
          ? value.parentCandidateRef
          : null,
    };
  }
  async release(ref: string): Promise<void> {
    await rm(join(this.directory, safeId(ref)), {
      recursive: true,
      force: true,
    });
  }
}
