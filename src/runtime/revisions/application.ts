import {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
  unlink,
  rmdir,
  rename,
  chmod,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type {
  ArtifactStore,
  FactStore,
  JsonObject,
  FileTreeFile,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import { canonical, object, string } from '../../shared/json.js';
import { errorText } from '../../shared/errors.js';
import { safeId } from '../storage/index.js';
import {
  pathContains,
  resourcePath,
  validateEditableDestinations,
  canonicalDestinationPath,
} from './resources.js';
import { acquireResourceGate, blockingExperiments } from './exclusion.js';
import { validateDestinationNames } from './destination-names.js';

interface SourceResource {
  pointer: string;
  kind: 'file' | 'directory';
  path: string;
  artifactPath: string;
}
interface Change {
  action: 'add' | 'replace' | 'remove';
  path: string;
  resource: SourceResource;
  content?: Buffer;
  mode?: number;
}
interface Plan {
  revision: JsonObject;
  resources: SourceResource[];
  snapshot: FileTreeFile[];
  changes: Change[];
  directories: string[];
  directoryAdditions: { path: string; resource: SourceResource }[];
}
interface ApplicationOptions {
  directory: string;
  rootDirectory: string;
  facts: FactStore;
  artifacts: ArtifactStore;
}
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const protectedNames = new Set(['.rsi', '.git', 'dist', 'node_modules']);
function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function stat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
function validName(name: string): boolean {
  return (
    !!name &&
    name !== '.' &&
    name !== '..' &&
    !/[<>:"|?*\x00-\x1f\\]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(
      name,
    )
  );
}
function validateEntry(path: string, destination = true): void {
  if (
    isAbsolute(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !validName(part) ||
          (destination && protectedNames.has(part.toLowerCase())),
      )
  )
    throw new Error(`Unsafe resource entry ${path}`);
}
/** lstat every existing component so neither junctions nor symbolic links are followed. */
async function inspectPath(
  path: string,
  replacingFileAncestor = false,
): Promise<void> {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let cursor = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    if (!validName(component))
      throw new Error(`Unsafe destination name ${component}`);
    cursor = join(cursor, component);
    const entry = await stat(cursor);
    if (!entry) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Linked destination rejected: ${cursor}`);
    if (cursor !== absolute && !entry.isDirectory()) {
      if (replacingFileAncestor && entry.isFile()) return;
      throw new Error(`Destination ancestor is not a directory: ${cursor}`);
    }
    if (!entry.isFile() && !entry.isDirectory())
      throw new Error(`Special destination rejected: ${cursor}`);
  }
}
function summary(revision: JsonObject): JsonObject {
  return {
    revisionID: revision.ref ?? null,
    experimentId: revision.experimentId ?? null,
    policyScopeId: revision.policyScopeId ?? null,
    generationPolicyScopeId:
      revision.generationPolicyScopeId ?? revision.policyScopeId ?? null,
    binding: revision.binding ?? null,
    pluginRef: revision.pluginRef ?? revision.pluginId ?? null,
    kind: revision.kind ?? 'legacy',
    reflectionId: revision.reflectionId ?? null,
    applicationMetadata:
      Array.isArray(revision.sourceResources) &&
      typeof revision.rootRef === 'string' &&
      typeof revision.resourceRef === 'string',
  };
}
/** Owns all revision application validation; CLI is only a caller of this boundary. */
export class RevisionApplication {
  constructor(private readonly options: ApplicationOptions) {}

  async list(experimentId?: string): Promise<JsonObject[]> {
    if (experimentId !== undefined) safeId(experimentId);
    return (await this.options.facts.list('revisions'))
      .filter(
        (record) =>
          experimentId === undefined || record.experimentId === experimentId,
      )
      .map(summary);
  }
  private async read(revisionID: string): Promise<JsonObject> {
    safeId(revisionID);
    try {
      const record = await this.options.facts.read('revisions', revisionID);
      if (record.ref !== revisionID)
        throw new Error('Revision identity mismatch');
      return record;
    } catch (error) {
      if (absent(error)) throw new Error(`Unknown revision ID ${revisionID}`);
      throw error;
    }
  }
  private resources(revision: JsonObject): SourceResource[] {
    if (
      !Array.isArray(revision.sourceResources) ||
      typeof revision.rootRef !== 'string' ||
      typeof revision.resourceRef !== 'string'
    )
      throw new Error(
        'Legacy revision has no complete snapshot or fixed application mapping',
      );
    return revision.sourceResources.map((raw) => {
      const record = object(raw),
        kind = string(record.kind);
      if (kind !== 'file' && kind !== 'directory')
        throw new Error('Invalid saved resource kind');
      const pointer = string(record.pointer),
        path = string(record.path),
        artifactPath = string(record.artifactPath);
      if (process.platform === 'win32' && /^\\\\[?.]\\/.test(path))
        throw new Error(
          `Windows device namespace destination aliases are not supported: ${path}`,
        );
      if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error(`Destination is not a resolved absolute path: ${path}`);
      if (artifactPath !== resourcePath(string(revision.binding), pointer))
        throw new Error(
          'Resource snapshot mapping does not match its binding and pointer',
        );
      validateEntry(artifactPath, false);
      return { pointer, kind, path, artifactPath };
    });
  }
  private async validateDestination(
    resource: SourceResource,
    revision: JsonObject,
  ): Promise<void> {
    const path = resolve(resource.path);
    await inspectPath(path);
    const physicalPath = await canonicalDestinationPath(path),
      parts = physicalPath.split(/[\\/]/).map((part) => part.toLowerCase());
    const protectedTrees = await Promise.all(
      [
        this.options.directory,
        join(packageRoot, 'src', 'policies'),
        join(packageRoot, 'src', 'plugins'),
      ].map(canonicalDestinationPath),
    );
    if (
      parts.some((part) => protectedNames.has(part)) ||
      protectedTrees.some(
        (root) =>
          pathContains(root, physicalPath) ||
          (resource.kind === 'directory' && pathContains(physicalPath, root)),
      )
    )
      throw new Error(
        `Protected destination ${String(revision.binding)}${resource.pointer}: ${path}. Configure a user-owned Recipe binding, for example guidance: ./guidance/${String(revision.binding)}`,
      );
    const projectRoots = await Promise.all(
      [this.options.rootDirectory, packageRoot].map(canonicalDestinationPath),
    );
    if (
      path === parse(path).root ||
      (resource.kind === 'directory' &&
        projectRoots.some((root) => pathContains(physicalPath, root)))
    )
      throw new Error(
        `Whole project or filesystem root is not a dedicated resource: ${path}`,
      );
    const existing = await stat(path);
    if (
      existing &&
      (resource.kind === 'file' ? !existing.isFile() : !existing.isDirectory())
    )
      throw new Error(
        `Destination kind differs from saved ${resource.kind}: ${path}`,
      );
    if (
      resource.kind === 'directory' &&
      ((await stat(join(path, '.git'))) ||
        (await stat(join(path, 'package.json'))))
    )
      throw new Error(`Project directory is not a dedicated resource: ${path}`);
  }
  private async plan(revision: JsonObject): Promise<Plan> {
    const resources = this.resources(revision),
      root = await this.read(string(revision.rootRef));
    const rootResources = this.resources(root);
    if (
      !['initial', 'generated'].includes(String(revision.kind)) ||
      root.kind !== 'initial' ||
      root.rootRef !== root.ref ||
      root.binding !== revision.binding ||
      root.policyScopeId !== revision.policyScopeId ||
      root.experimentId !== revision.experimentId ||
      root.pluginRef !== revision.pluginRef ||
      canonical(rootResources) !== canonical(resources)
    )
      throw new Error(
        'Revision destination mapping differs from its initial root',
      );
    if (!resources.length)
      throw new Error('Revision has no selected resources');
    await validateEditableDestinations(
      resources.map((resource) => ({
        ...resource,
        binding: string(revision.binding),
      })),
    );
    const snapshot = parseFileTree(
      await this.options.artifacts.readJson(string(revision.resourceRef)),
    ).files;
    const changes: Change[] = [],
      directories: string[] = [],
      desiredPaths: string[] = [];
    const directoryAdditions = new Map<
      string,
      { path: string; resource: SourceResource }
    >();
    const requireDirectory = async (
      path: string,
      resource: SourceResource,
    ): Promise<void> => {
      const needed: string[] = [];
      for (let current = path; ; current = dirname(current)) {
        const existing = await lstat(current).catch((error: unknown) => {
          if (
            absent(error) ||
            (error instanceof Error &&
              'code' in error &&
              error.code === 'ENOTDIR')
          )
            return undefined;
          throw error;
        });
        if (existing?.isDirectory()) break;
        if (existing?.isSymbolicLink())
          throw new Error(`Linked destination rejected: ${current}`);
        needed.push(current);
        if (dirname(current) === current)
          throw new Error(
            `Destination filesystem root is unavailable: ${current}`,
          );
      }
      for (const directory of needed.reverse()) {
        const physical = await canonicalDestinationPath(directory);
        const key =
          process.platform === 'win32' ? physical.toLowerCase() : physical;
        if (!directoryAdditions.has(key))
          directoryAdditions.set(key, { path: directory, resource });
      }
    };
    for (const resource of resources) {
      await this.validateDestination(resource, revision);
      const selected = snapshot.filter((file) =>
        resource.kind === 'file'
          ? file.path === resource.artifactPath
          : file.path.startsWith(resource.artifactPath + '/'),
      );
      if (resource.kind === 'file' && selected.length !== 1)
        throw new Error(`File snapshot missing: ${resource.pointer}`);
      const wanted = new Map<string, { content: Buffer; mode: number }>();
      for (const file of selected) {
        const local =
          resource.kind === 'file'
            ? ''
            : file.path.slice(resource.artifactPath.length + 1);
        if (local) validateEntry(local);
        const target = local
          ? resolve(resource.path, ...local.split('/'))
          : resource.path;
        if (!pathContains(resource.path, target))
          throw new Error('Snapshot entry escapes resource');
        await inspectPath(target, resource.kind === 'directory');
        wanted.set(target, {
          content: Buffer.from(file.base64, 'base64'),
          mode: file.mode,
        });
      }
      const targetPaths = [...wanted.keys()];
      desiredPaths.push(...targetPaths);
      const currentFiles = new Map<string, { content: Buffer; mode: number }>();
      const walk = async (path: string): Promise<void> => {
        await inspectPath(path);
        const entry = await stat(path);
        if (!entry) return;
        if (entry.isFile()) {
          currentFiles.set(path, {
            content: await readFile(path),
            mode: entry.mode & 0o777,
          });
          return;
        }
        directories.push(path);
        for (const name of await readdir(path)) {
          if (!validName(name) || protectedNames.has(name.toLowerCase()))
            throw new Error(`Unsafe existing destination entry ${name}`);
          await walk(join(path, name));
        }
      };
      await walk(resource.path);
      if (resource.kind === 'directory')
        await requireDirectory(resource.path, resource);
      for (const [path, { content, mode }] of wanted) {
        await requireDirectory(dirname(path), resource);
        const existing = currentFiles.get(path);
        if (
          !existing ||
          !existing.content.equals(content) ||
          (process.platform !== 'win32' && existing.mode !== mode)
        )
          changes.push({
            action: existing ? 'replace' : 'add',
            path,
            resource,
            content,
            mode,
          });
      }
      for (const path of currentFiles.keys())
        if (!wanted.has(path))
          changes.push({ action: 'remove', path, resource });
    }
    await validateDestinationNames(desiredPaths);
    return {
      revision,
      resources,
      snapshot,
      changes: changes.sort(
        (a, b) => Number(b.action === 'remove') - Number(a.action === 'remove'),
      ),
      directories: directories
        .filter(
          (path) =>
            !resources.some((resource) => resource.path === path) &&
            !desiredPaths.some(
              (wanted) => wanted !== path && pathContains(path, wanted),
            ),
        )
        .sort((a, b) => b.length - a.length),
      directoryAdditions: [...directoryAdditions.values()].sort(
        (a, b) => a.path.length - b.path.length,
      ),
    };
  }
  async show(revisionID: string): Promise<JsonObject> {
    const revision = await this.read(revisionID);
    let plan: Plan | undefined;
    const restrictions: string[] = [];
    let snapshot: FileTreeFile[] = [];
    if (typeof revision.resourceRef === 'string') {
      try {
        const tree = parseFileTree(
          await this.options.artifacts.readJson(revision.resourceRef),
        ).files;
        // Legacy records may show their own binding tree even when application metadata is absent.
        const prefix = `bindings/${safeId(string(revision.binding))}/resources/`;
        snapshot = tree.filter((file) => file.path.startsWith(prefix));
        if (Array.isArray(revision.sourceResources)) {
          const resources = this.resources(revision);
          snapshot = snapshot.filter((file) =>
            resources.some((resource) =>
              resource.kind === 'file'
                ? file.path === resource.artifactPath
                : file.path.startsWith(resource.artifactPath + '/'),
            ),
          );
        }
      } catch (error) {
        restrictions.push(`Snapshot unavailable: ${errorText(error)}`);
      }
    }
    const gate = await acquireResourceGate(this.options.directory);
    try {
      const blockers = await blockingExperiments(
        this.options.directory,
        this.options.facts,
      );
      if (blockers.length)
        restrictions.push(
          `Active or unresolved experiments: ${blockers.join(', ')}. Retry after completion or recovery.`,
        );
      else {
        try {
          gate.assertOwned();
          // Planning probes the source filesystem; keep startup excluded through cleanup.
          const prepared = await this.plan(revision);
          gate.assertOwned();
          plan = prepared;
        } catch (error) {
          restrictions.push(errorText(error));
        }
      }
    } finally {
      await gate.release();
    }
    return {
      ...summary(revision),
      rootRef: revision.rootRef ?? null,
      sourceResources: revision.sourceResources ?? [],
      resourceRef: revision.resourceRef ?? null,
      reason: revision.reason ?? null,
      parentRef: revision.parentRef ?? null,
      snapshot,
      changes: plan
        ? [
            ...plan.changes.map(({ action, path }) => ({ action, path })),
            ...plan.directories.map((path) => ({
              action: 'remove',
              kind: 'directory',
              path,
            })),
            ...plan.directoryAdditions.map(({ path }) => ({
              action: 'add',
              kind: 'directory',
              path,
            })),
          ]
        : [],
      applicationAllowed: restrictions.length === 0,
      restrictions,
    };
  }
  async apply(revisionID: string): Promise<JsonObject> {
    const gate = await acquireResourceGate(this.options.directory);
    const completed: JsonObject[] = [];
    try {
      const blockers = await blockingExperiments(
        this.options.directory,
        this.options.facts,
      );
      if (blockers.length)
        throw new Error(
          `Active or unresolved experiments block application: ${blockers.join(', ')}. Retry after they finish or recover them first.`,
        );
      const plan = await this.plan(await this.read(revisionID));
      try {
        gate.assertOwned();
        for (const resource of plan.resources) {
          await this.validateDestination(resource, plan.revision);
        }
        for (const change of plan.changes.filter(
          (change) => change.action === 'remove',
        )) {
          await this.validateDestination(change.resource, plan.revision);
          await inspectPath(change.path);
          gate.assertOwned();
          await unlink(change.path);
          completed.push({ action: change.action, path: change.path });
        }
        for (const path of plan.directories) {
          await inspectPath(path);
          gate.assertOwned();
          await rmdir(path);
          completed.push({ action: 'remove', kind: 'directory', path });
        }
        for (const addition of plan.directoryAdditions) {
          await this.validateDestination(addition.resource, plan.revision);
          await inspectPath(addition.path);
          const existing = await stat(addition.path);
          if (existing) {
            if (!existing.isDirectory())
              throw new Error(`Destination changed kind: ${addition.path}`);
            continue;
          }
          gate.assertOwned();
          await mkdir(addition.path);
          completed.push({
            action: 'add',
            kind: 'directory',
            path: addition.path,
          });
          await inspectPath(addition.path);
        }
        for (const change of plan.changes.filter(
          (change) => change.action !== 'remove',
        )) {
          await this.validateDestination(change.resource, plan.revision);
          {
            await inspectPath(change.path);
            const existing = await stat(change.path);
            if (existing && !existing.isFile())
              throw new Error(`Destination changed kind: ${change.path}`);
            const temporary = join(
              dirname(change.path),
              `.rsi-apply-${randomUUID()}.tmp`,
            );
            try {
              gate.assertOwned();
              await writeFile(temporary, change.content!, {
                flag: 'wx',
                mode: change.mode,
              });
              if (process.platform !== 'win32')
                await chmod(temporary, change.mode!);
              await inspectPath(change.path);
              gate.assertOwned();
              // Replacing a directory entry never follows an existing file link.
              await rename(temporary, change.path);
            } finally {
              try {
                await unlink(temporary);
              } catch (error) {
                if (!absent(error)) throw error;
              }
            }
          }
          completed.push({ action: change.action, path: change.path });
        }
      } catch (error) {
        throw new Error(
          `Revision application failed; completed changes: ${canonical(completed)}; ${errorText(error)}`,
          { cause: error },
        );
      }
      return {
        revisionID,
        status: completed.length ? 'applied' : 'unchanged',
        changes: completed,
      };
    } finally {
      await gate.release();
    }
  }
}
