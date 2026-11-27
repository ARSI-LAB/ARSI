import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  segments,
  validateEditableDestinations,
  canonicalDestinationPath,
  parseCoveringRoots,
  memberPath,
  type CoveringRoot,
} from './resources.js';
import { revisionDepths } from './records.js';
import { acquireResourceGate, blockingExperiments } from './exclusion.js';
import {
  inspectPath,
  protectedNames,
  validName,
  stat,
  absent,
  validateSnapshotEntry,
  validateSnapshotDestination,
} from './snapshot-paths.js';
export {
  validateSnapshotDestination,
  validateSnapshotEntry,
} from './snapshot-paths.js';
import {
  publishSnapshots,
  type SnapshotTarget,
} from './snapshot-publication.js';
import { validateDestinationNames } from './destination-names.js';

interface SourceResource {
  physicalPath?: string;
  pointer?: string;
  directories?: string[];
  kind: 'file' | 'directory';
  path: string;
  artifactPath: string;
}
function snapshotFiles(
  resource: SourceResource,
  files: FileTreeFile[],
): FileTreeFile[] {
  return files.filter((file) =>
    resource.kind === 'file'
      ? file.path === resource.artifactPath
      : !resource.artifactPath ||
        file.path.startsWith(resource.artifactPath + '/'),
  );
}

/** Compare immutable tree entries independent of their serialization order. */
function sameRoot(
  resource: CoveringRoot,
  initial: Map<string, FileTreeFile>,
  files: FileTreeFile[],
): boolean {
  const selected = snapshotFiles(resource, files);
  return (
    selected.length === initial.size &&
    selected.every((file) => {
      const prior = initial.get(file.path);
      return prior?.mode === file.mode && prior.base64 === file.base64;
    })
  );
}
interface Change {
  action: 'add' | 'replace' | 'remove';
  path: string;
  resource: SourceResource;
}
interface Plan {
  resources: SourceResource[];
  targets: SnapshotTarget[];
  changes: JsonObject[];
  parents: string[];
}
interface ApplicationOptions {
  directory: string;
  rootDirectory: string;
  facts: FactStore;
  artifacts: ArtifactStore;
}
function summary(revision: JsonObject): JsonObject {
  return {
    revisionID: revision.ref ?? null,
    experimentId: revision.experimentId ?? null,
    policyScopeId: revision.policyScopeId ?? null,
    generationPolicyScopeId:
      revision.generationPolicyScopeId ?? revision.policyScopeId ?? null,
    ...(Array.isArray(revision.sourceRoots)
      ? {
          bindings: revision.bindings ?? [],
          changedBindings: revision.changedBindings ?? [],
          sourceRoots: revision.sourceRoots,
        }
      : {
          binding: revision.binding ?? null,
          pluginRef: revision.pluginRef ?? revision.pluginId ?? null,
        }),
    kind: revision.kind ?? 'legacy',
    evolutionId: revision.evolutionId ?? null,
    applicationMetadata:
      (Array.isArray(revision.sourceRoots) ||
        Array.isArray(revision.sourceResources)) &&
      typeof revision.rootRef === 'string' &&
      typeof revision.resourceRef === 'string',
  };
}
/** Plan and apply immutable snapshots under the same gate as experiment startup. */
class SnapshotApplication {
  constructor(
    private readonly options: ApplicationOptions,
    private readonly collection: 'memory-revisions' | 'revisions',
  ) {}

  private summary(record: JsonObject): JsonObject {
    if (this.collection === 'revisions') return summary(record);
    return {
      memoryID: record.ref ?? null,
      experimentId: record.experimentId ?? null,
      parentRef: record.parentRef ?? null,
      kind: record.kind ?? null,
      artifactRef: record.artifactRef ?? null,
    };
  }

  async list(experimentId?: string): Promise<JsonObject[]> {
    if (experimentId !== undefined) safeId(experimentId);
    const records = (await this.options.facts.list(this.collection)).filter(
      (record) =>
        experimentId === undefined || record.experimentId === experimentId,
    );
    if (this.collection === 'revisions') {
      const depths = revisionDepths(records);
      records.sort(
        (a, b) =>
          String(a.experimentId).localeCompare(String(b.experimentId)) ||
          (depths.get(String(b.ref)) ?? 0) - (depths.get(String(a.ref)) ?? 0),
      );
    }
    return records.map((record) => this.summary(record));
  }
  private async read(revisionID: string): Promise<JsonObject> {
    safeId(revisionID);
    try {
      const record = await this.options.facts.read(this.collection, revisionID);
      if (record.ref !== revisionID)
        throw new Error(`${this.collection} identity mismatch`);
      return record;
    } catch (error) {
      if (absent(error))
        throw new Error(
          `Unknown ${this.collection === 'revisions' ? 'revision' : 'memory'} ID ${revisionID}`,
        );
      throw error;
    }
  }
  private legacyResources(
    revision: JsonObject,
  ): (SourceResource & { pointer: string })[] {
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
      validateSnapshotEntry(artifactPath, false);
      return { pointer, kind, path, artifactPath };
    });
  }
  private async destinations(
    record: JsonObject,
    snapshot: FileTreeFile[],
    to?: string,
  ): Promise<SourceResource[]> {
    const joint =
      record.sourceRoots !== undefined && this.collection === 'revisions';
    const revisionResources =
      this.collection === 'revisions' && !joint
        ? this.legacyResources(record)
        : [];
    const root = await this.read(string(record.rootRef));
    if (root.rootRef !== root.ref || root.experimentId !== record.experimentId)
      throw new Error('Snapshot does not belong to its recorded root');
    if (to !== undefined && !to.trim())
      throw new Error('Expected a destination directory');
    const target = to === undefined ? undefined : resolve(to);
    if (target)
      await validateSnapshotDestination(
        target,
        'directory',
        this.options.rootDirectory,
        this.options.directory,
      );
    if (this.collection === 'memory-revisions') {
      const source = root.sourceDirectory;
      if (!target && (root.kind !== 'initial' || typeof source !== 'string'))
        throw new Error(
          'This Memory has no seed directory. Choose a dedicated export directory.',
        );
      const path = target ?? string(source);
      if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error('Invalid Memory seed directory');
      return [{ pointer: '', path, kind: 'directory', artifactPath: '' }];
    }
    if (joint) {
      const roots = parseCoveringRoots(record.sourceRoots);
      if (
        !['initial', 'generated'].includes(String(record.kind)) ||
        root.kind !== 'initial' ||
        root.policyScopeId !== record.policyScopeId ||
        canonical(root.sourceRoots ?? null) !== canonical(record.sourceRoots) ||
        canonical(root.bindings ?? null) !== canonical(record.bindings ?? null)
      )
        throw new Error(
          'Revision destination mapping differs from its initial root',
        );
      const initial =
        record.ref === root.ref
          ? undefined
          : parseFileTree(
              await this.options.artifacts.readJson(string(root.resourceRef)),
            ).files;
      const direct = roots.length === 1 && roots[0]!.kind === 'directory';
      const paths = new Set(snapshot.map((file) => file.path));
      return roots
        .filter((resource) => {
          for (const member of resource.members) {
            const path = memberPath(resource, member);
            if (member.kind === 'file' && !paths.has(path))
              throw new Error('File snapshot missing: ' + path);
            if (member.kind === 'directory' && paths.has(path))
              throw new Error(
                'File snapshot replaces a selected directory: ' + path,
              );
          }
          if (!initial) return true;
          const originals = new Map(
            snapshotFiles(resource, initial).map((file) => [file.path, file]),
          );
          return !sameRoot(resource, originals, snapshot);
        })
        .map(({ path, physicalPath, kind, artifactPath, members }) => ({
          ...(!target && physicalPath ? { physicalPath } : {}),
          kind,
          artifactPath,
          directories: [
            ...new Set(
              members
                .filter(
                  (member) =>
                    member.kind === 'directory' && member.relativePath,
                )
                .map((member) => member.relativePath),
            ),
          ],
          path: !target
            ? path
            : direct
              ? target
              : join(target, ...artifactPath.split('/').slice(1)),
        }));
    }
    const resources = revisionResources;
    if (
      !['initial', 'generated'].includes(String(record.kind)) ||
      root.kind !== 'initial' ||
      root.binding !== record.binding ||
      root.policyScopeId !== record.policyScopeId ||
      root.pluginRef !== record.pluginRef ||
      canonical(this.legacyResources(root)) !== canonical(resources)
    )
      throw new Error(
        'Revision destination mapping differs from its initial root',
      );
    if (!resources.length)
      throw new Error('Revision has no selected resources');
    if (!target) return resources;
    const direct = resources.length === 1 && resources[0]!.kind === 'directory';
    return resources.map((resource) => ({
      ...resource,
      path: direct
        ? target
        : join(
            target,
            safeId(string(record.binding)),
            ...segments(resource.pointer),
          ),
    }));
  }
  private async plan(revision: JsonObject, to?: string): Promise<Plan> {
    const snapshot = parseFileTree(
      await this.options.artifacts.readJson(
        string(
          this.collection === 'memory-revisions'
            ? revision.artifactRef
            : revision.resourceRef,
        ),
      ),
    ).files;
    const resources = await this.destinations(revision, snapshot, to);
    await validateEditableDestinations(
      resources.map((resource) => ({
        ...resource,
        binding: String(revision.binding ?? this.collection),
        pointer: resource.pointer ?? resource.artifactPath,
      })),
    );
    const changes: Change[] = [],
      removedDirectories: { path: string; resource: SourceResource }[] = [],
      desiredPaths: string[] = [];
    const filesByResource = new Map<SourceResource, FileTreeFile[]>();
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
      await validateSnapshotDestination(
        resource.path,
        resource.kind,
        this.options.rootDirectory,
        this.options.directory,
      );
      if (
        revision.sourceRoots !== undefined &&
        to === undefined &&
        relative(
          resource.physicalPath ?? resource.path,
          await canonicalDestinationPath(resource.path),
        ) !== ''
      )
        throw new Error(
          'Recorded destination changed its physical path: ' + resource.path,
        );
      const selected = snapshotFiles(resource, snapshot);
      if (resource.kind === 'file' && selected.length !== 1)
        throw new Error(`File snapshot missing: ${resource.pointer}`);
      const files: FileTreeFile[] = [];
      filesByResource.set(resource, files);
      const directories: string[] = [];
      const wanted = new Map<string, { content: Buffer; mode: number }>();
      for (const file of selected) {
        const local =
          resource.kind === 'file'
            ? ''
            : resource.artifactPath
              ? file.path.slice(resource.artifactPath.length + 1)
              : file.path;
        if (local) validateSnapshotEntry(local);
        if (
          resource.kind === 'directory' &&
          local.toLowerCase() === 'package.json'
        )
          throw new Error(
            'Snapshot would create a project directory: ' + resource.path,
          );
        const target = local
          ? resolve(resource.path, ...local.split('/'))
          : resource.path;
        if (!pathContains(resource.path, target))
          throw new Error('Snapshot entry escapes resource');
        await inspectPath(target, resource.kind === 'directory');
        files.push({ ...file, path: local });
        wanted.set(target, {
          content: Buffer.from(file.base64, 'base64'),
          mode: file.mode,
        });
      }
      const targetPaths = [...wanted.keys()];
      const declaredDirectories: string[] = [];
      for (const local of resource.directories ?? []) {
        validateSnapshotEntry(local);
        const directory = join(resource.path, ...local.split('/'));
        await inspectPath(directory, true);
        await requireDirectory(directory, resource);
        declaredDirectories.push(directory);
      }
      // Name probes use leaves: files imply all their parent directories, while
      // an explicitly selected empty directory has no file to represent it.
      const leaves = [...targetPaths, ...declaredDirectories];
      desiredPaths.push(
        ...targetPaths,
        ...declaredDirectories.filter(
          (directory) =>
            !leaves.some((path) => path.startsWith(directory + sep)),
        ),
      );
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
          });
      }
      for (const path of currentFiles.keys())
        if (!wanted.has(path))
          changes.push({ action: 'remove', path, resource });
      for (const path of directories)
        if (
          path !== resource.path &&
          !declaredDirectories.some((directory) =>
            pathContains(path, directory),
          ) &&
          !targetPaths.some(
            (wanted) => wanted !== path && pathContains(path, wanted),
          )
        )
          removedDirectories.push({ path, resource });
    }
    await validateDestinationNames(desiredPaths);
    const additions = [...directoryAdditions.values()].sort(
      (a, b) => a.path.length - b.path.length,
    );
    const touched = new Set(
      [...changes, ...removedDirectories, ...additions].map(
        (change) => change.resource,
      ),
    );
    const targets = resources
      .filter((resource) => touched.has(resource))
      .map((resource) => ({
        path: resource.path,
        kind: resource.kind,
        files: filesByResource.get(resource)!,
        directories: resource.directories,
      }));
    return {
      resources,
      targets,
      parents: additions
        .map(({ path }) => path)
        .filter((path) =>
          targets.some((target) => pathContains(path, dirname(target.path))),
        ),
      changes: [
        ...changes
          .sort(
            (a, b) =>
              Number(b.action === 'remove') - Number(a.action === 'remove'),
          )
          .map(({ action, path }) => ({ action, path })),
        ...removedDirectories
          .sort((a, b) => b.path.length - a.path.length)
          .map(({ path }) => ({ action: 'remove', kind: 'directory', path })),
        ...additions.map(({ path }) => ({
          action: 'add',
          kind: 'directory',
          path,
        })),
      ],
    };
  }
  async show(
    revisionID: string,
    { to }: { to?: string } = {},
  ): Promise<JsonObject> {
    const revision = await this.read(revisionID);
    let plan: Plan | undefined;
    const restrictions: string[] = [];
    let snapshot: FileTreeFile[] = [];
    const resourceRef =
      this.collection === 'memory-revisions'
        ? revision.artifactRef
        : revision.resourceRef;
    if (typeof resourceRef === 'string') {
      try {
        const tree = parseFileTree(
          await this.options.artifacts.readJson(resourceRef),
        ).files;
        // Legacy records may show their own binding tree even when application metadata is absent.
        if (this.collection === 'memory-revisions') snapshot = tree;
        else if (revision.sourceRoots !== undefined)
          snapshot = parseCoveringRoots(revision.sourceRoots).flatMap((root) =>
            snapshotFiles(root, tree),
          );
        else if (Array.isArray(revision.sourceResources))
          snapshot = this.legacyResources(revision).flatMap((resource) =>
            snapshotFiles(resource, tree),
          );
        else {
          const prefix = `bindings/${safeId(string(revision.binding))}/resources/`;
          snapshot = tree.filter((file) => file.path.startsWith(prefix));
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
          const prepared = await this.plan(revision, to);
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
      ...this.summary(revision),
      rootRef: revision.rootRef ?? null,
      ...(revision.sourceRoots === undefined
        ? { sourceResources: revision.sourceResources ?? [] }
        : {}),
      destinations:
        plan?.resources.map(({ pointer, artifactPath, kind, path }) => ({
          ...(pointer === undefined ? { artifactPath } : { pointer }),
          kind,
          path,
        })) ?? [],
      resourceRef: resourceRef ?? null,
      reason: revision.reason ?? null,
      parentRef: revision.parentRef ?? null,
      snapshot,
      changes: plan?.changes ?? [],
      applicationAllowed: restrictions.length === 0,
      restrictions,
    };
  }
  async apply(
    revisionID: string,
    { to }: { to?: string } = {},
  ): Promise<JsonObject> {
    const gate = await acquireResourceGate(this.options.directory);
    try {
      const blockers = await blockingExperiments(
        this.options.directory,
        this.options.facts,
      );
      if (blockers.length)
        throw new Error(
          `Active or unresolved experiments block application: ${blockers.join(', ')}. Retry after they finish or recover them first.`,
        );
      const plan = await this.plan(await this.read(revisionID), to);
      if (plan.targets.length)
        await publishSnapshots(
          this.options.directory,
          this.options.rootDirectory,
          gate,
          plan.targets,
          plan.parents,
        );
      return {
        [this.collection === 'revisions' ? 'revisionID' : 'memoryID']:
          revisionID,
        status: plan.changes.length ? 'applied' : 'unchanged',
        changes: plan.changes,
      };
    } finally {
      await gate.release();
    }
  }
}

export class RevisionApplication extends SnapshotApplication {
  constructor(options: ApplicationOptions) {
    super(options, 'revisions');
  }
}

export class MemoryApplication extends SnapshotApplication {
  constructor(options: ApplicationOptions) {
    super(options, 'memory-revisions');
  }
}
