import { mkdir, mkdtemp, readFile, lstat, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseFileTree,
  type Binding,
  type FileTreeFile,
  type JsonObject,
  type JsonValue,
} from '../../contracts/index.js';
import { canonical, digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { persistFact } from '../storage/persistence-error.js';
import type { LearningResult } from './records.js';
import {
  assignPointer,
  memberPath,
  parseCoveringRoots,
  pointerValue,
  resolveCoveringRoots,
  selectedResourceFields,
  type CoveringRoot,
  type EditableRoot,
  type ResourceMember,
} from './resources.js';
import {
  optionalFact,
  runLearningCycle,
  type CycleOptions,
  type LearningCycle,
} from './runner.js';
import type { ReflectionConfig } from './validation.js';

export interface ReflectionOptions extends CycleOptions {
  config: ReflectionConfig;
  reflectionRevisionRef: string | null;
  sourceResources?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  initialize(parents: JsonObject, reflectionRevisionRef: string): Promise<void>;
  save(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
    reflectionRevisionRef: string,
  ): Promise<void>;
}

function covers(
  root: CoveringRoot,
  member: ResourceMember,
  path: string,
): boolean {
  const selected = memberPath(root, member);
  return (
    path === selected ||
    (member.kind === 'directory' && path.startsWith(selected + '/'))
  );
}

function manifestFor(roots: CoveringRoot[]): JsonObject {
  const manifest: JsonObject = {};
  for (const root of roots) {
    for (const member of root.members) {
      const path = memberPath(root, member);
      const key = member.kind === 'directory' ? path + '/' : path;
      if (!Object.hasOwn(manifest, key))
        manifest[key] = {
          kind: member.kind,
          owners: root.members
            .filter((owner) => covers(root, owner, path))
            .map(({ binding, pointer }) => ({ binding, pointer })),
          changes:
            member.kind === 'directory' ? ['create', 'modify'] : ['modify'],
        };
    }
  }
  return manifest;
}

function selectedEntries(
  options: ReflectionOptions,
  bindings: string[],
): EditableRoot[] {
  return bindings.flatMap((key) => {
    const binding = options.bindings[key]!;
    const fields = selectedResourceFields(
      options.getDefinition(binding.plugin).configSchema,
      binding.config,
      options.config.targets[key]!.resources,
    );
    return fields.map(({ pointer, kind }) => ({
      binding: key,
      pointer,
      kind,
      path:
        options.sourceResources?.[key]?.[pointer] ??
        string(pointerValue(binding.config, pointer)),
    }));
  });
}

function selection(
  entries: readonly Pick<ResourceMember, 'binding' | 'pointer' | 'kind'>[],
): string {
  return canonical(
    entries
      .map(({ binding, pointer, kind }) => canonical([binding, pointer, kind]))
      .sort(),
  );
}

async function initialSnapshot(
  options: ReflectionOptions,
  bindings: string[],
  entries: EditableRoot[],
): Promise<JsonObject> {
  // Identity uses the original locations. Contents come from the locked (or restored) bindings.
  const roots = await resolveCoveringRoots(entries);
  const artifacts = options.context.artifacts;
  const files: FileTreeFile[] = [];
  for (const root of roots) {
    const owner = root.members.find((member) => member.relativePath === '')!;
    const source = string(
      pointerValue(options.bindings[owner.binding]!.config, owner.pointer),
    );
    if (root.kind === 'directory') {
      const tree = parseFileTree(
        await artifacts.readJson(await artifacts.capture(source)),
      );
      for (const file of tree.files)
        files.push({ ...file, path: root.artifactPath + '/' + file.path });
    } else {
      const stat = await lstat(source);
      if (!stat.isFile())
        throw new Error('Expected regular Reflection source file: ' + source);
      files.push({
        path: root.artifactPath,
        base64: (await readFile(source)).toString('base64'),
        mode: stat.mode & 0o777,
      });
    }
  }
  files.push({
    path: 'manifest.json',
    base64: Buffer.from(canonical(manifestFor(roots))).toString('base64'),
    mode: process.platform === 'win32' ? 0o666 : 0o644,
  });
  const tree = { kind: 'file-tree', files };
  checkMembers(roots, parseFiles(tree));
  const resourceRef = await artifacts.putJson(tree);
  const experimentId = options.context.experimentId,
    policyScopeId = options.invocation.policyScopeId;
  const ref =
    'revision-' +
    digest({
      experimentId,
      policyScopeId,
      roots,
      resourceRef,
      bindings: bindings.map((key) => options.bindings[key]),
    });
  const initial = {
    ref,
    parentRef: null,
    rootRef: ref,
    kind: 'initial',
    experimentId,
    policyScopeId,
    bindings,
    sourceRoots: roots,
    resourceRef,
  };
  await persistFact(options.context.facts, 'revisions', ref, initial);
  await options.initialize(
    Object.fromEntries(bindings.map((key) => [key, ref])),
    ref,
  );
  return initial;
}

async function activationIncludes(
  options: ReflectionOptions,
  record: JsonObject,
): Promise<boolean> {
  const committed = await optionalFact(
    options.context.facts,
    'activations',
    options.context.experimentId,
  );
  if (!committed) return false;
  async function includes(
    ref: JsonValue | undefined,
    expected: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    while (typeof ref === 'string' && !visited.has(ref)) {
      if (ref === expected) return true;
      visited.add(ref);
      ref = (await optionalFact(options.context.facts, 'revisions', ref))
        ?.parentRef;
    }
    return false;
  }
  if (typeof record.reflectionRevisionRef === 'string')
    return includes(
      committed.reflectionRevisionRef,
      record.reflectionRevisionRef,
    );
  // Older validated checkpoints linked one generated revision per binding.
  const changes = Object.entries(object(record.revisions));
  const active = object(committed.revisions);
  for (const [binding, expected] of changes)
    if (!(await includes(active[binding], string(expected)))) return false;
  return changes.length > 0;
}
function parentsMatch(options: ReflectionOptions, record: JsonObject): boolean {
  return (
    options.reflectionRevisionRef === record.parentRef &&
    Object.entries(object(record.parents)).every(
      ([key, ref]) => options.revisionRefs[key] === ref,
    )
  );
}

export async function reflect(
  options: ReflectionOptions,
): Promise<LearningResult> {
  return runLearningCycle(options, 'reflection', {
    includes: (record) => activationIncludes(options, record),
    parentsMatch: (record) => parentsMatch(options, record),
    execute: (cycle) => reviseResources(options, cycle),
  });
}

function parseFiles(value: JsonValue): Map<string, FileTreeFile> {
  return new Map(parseFileTree(value).files.map((file) => [file.path, file]));
}
function checkMembers(
  roots: CoveringRoot[],
  files: Map<string, FileTreeFile>,
): void {
  for (const root of roots)
    for (const member of root.members) {
      const path = memberPath(root, member);
      if (member.kind === 'file' && !files.has(path))
        throw new Error(
          'Reflection delete denied: required file member ' + path,
        );
      if (member.kind === 'directory' && files.has(path))
        throw new Error('Reflection replaced directory member ' + path);
    }
}
function changedOwners(
  roots: CoveringRoot[],
  oldFiles: Map<string, FileTreeFile>,
  newFiles: Map<string, FileTreeFile>,
): string[] {
  const changed = new Set<string>();
  checkMembers(roots, newFiles);
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const before = oldFiles.get(path),
      after = newFiles.get(path);
    if (canonical(before ?? null) === canonical(after ?? null)) continue;
    const root = roots.find(
      (root) =>
        path === root.artifactPath ||
        (root.kind === 'directory' && path.startsWith(root.artifactPath + '/')),
    );
    if (!root) throw new Error('Reflection edit outside authorized resource');
    if (!after) throw new Error('Reflection delete denied');
    if ((after.mode & 0o111) !== 0 || (before && after.mode !== before.mode))
      throw new Error('Reflection resource mode change denied');
    new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(after.base64, 'base64'),
    );
    for (const member of root.members)
      if (covers(root, member, path)) changed.add(member.binding);
  }
  return [...changed].sort();
}

/** Publish only complete projection directories so interruption cannot strand a partial revision. */
async function materializeRevision(
  options: ReflectionOptions,
  ref: string,
  after: string,
  roots: CoveringRoot[],
): Promise<string> {
  const permanent = join(
    options.directory,
    'experiments',
    options.context.experimentId,
    'revisions',
    ref,
    'resources',
  );
  const exists = await lstat(permanent).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (exists) {
    if (!exists.isDirectory())
      throw new Error('Invalid Reflection revision directory');
    return permanent;
  }
  await mkdir(dirname(permanent), { recursive: true });
  const staging = await mkdtemp(join(dirname(permanent), '.projection-'));
  try {
    await options.context.artifacts.materialize(after, staging);
    // Empty selected directories are represented in the manifest, not in file-tree artifacts.
    for (const root of roots)
      for (const member of root.members)
        if (member.kind === 'directory')
          await mkdir(join(staging, memberPath(root, member)), {
            recursive: true,
          });
    await rename(staging, permanent);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return permanent;
}

async function reviseResources(
  options: ReflectionOptions,
  cycle: LearningCycle,
): Promise<LearningResult> {
  const { prior, identity, assertScope, save, finish } = cycle;
  if (prior?.status === 'validated') {
    if (!(await activationIncludes(options, prior))) {
      assertScope();
      if (!parentsMatch(options, prior))
        throw new Error(
          'Reflection recovery conflicts with current active revisions',
        );
      const changes = Object.fromEntries(
        Object.entries(object(prior.bindings)).map(([key, value]) => {
          const binding = object(value);
          return [
            key,
            {
              ...options.bindings[key]!,
              plugin: string(binding.plugin),
              config: object(binding.config),
            },
          ];
        }),
      );
      await options.save(
        changes,
        object(prior.revisions),
        identity,
        string(prior.reflectionRevisionRef),
      );
    }
    return finish('activated', prior);
  }
  const collected = await cycle.evidence();
  const bindings = Object.keys(options.config.targets).sort();
  if (!bindings.length)
    return finish('skipped', { reason: 'no editable resources' });
  const existingHead = options.reflectionRevisionRef;
  let parent = existingHead
    ? await options.context.facts.read('revisions', existingHead)
    : null;
  const entries = selectedEntries(options, bindings);
  let roots = parent ? parseCoveringRoots(parent.sourceRoots) : [];
  if (
    !parent ||
    selection(roots.flatMap((root) => root.members)) !== selection(entries)
  ) {
    parent = await initialSnapshot(options, bindings, entries);
    roots = parseCoveringRoots(parent.sourceRoots);
  }
  const parentRef = string(parent.ref),
    before = string(parent.resourceRef);
  const parents: JsonObject = Object.fromEntries(
    bindings.map((key) => [
      key,
      existingHead === parentRef
        ? string(options.revisionRefs[key])
        : parentRef,
    ]),
  );
  assertScope();
  if (!collected.callCount)
    return finish('skipped', {
      parents,
      reason: 'no usable observations in this evidence window',
    });
  const input: JsonObject = {
    goal: options.config.goal,
    parentRevisionRefs: parents,
    resourceRef: before,
    evidenceRefs: collected.ref ? [collected.ref] : [],
    editConstraints: {
      allowedPaths: roots.map((root) =>
        root.kind === 'file' ? root.artifactPath : root.artifactPath + '/**/*',
      ),
    },
  };
  if (prior?.status === 'prepared') {
    if (
      canonical(prior.parents) !== canonical(parents) ||
      prior.parentRef !== parentRef ||
      prior.resourceRef !== before ||
      canonical(prior.input) !== canonical(input)
    )
      throw new Error('Prepared Reflection input changed before recovery');
  } else
    await save('prepared', {
      parents,
      parentRef,
      resourceRef: before,
      input,
      callIds: collected.callIds,
      evidenceViewRef: collected.ref,
    });
  assertScope();
  const result = object(await cycle.invoke(input));
  assertScope();
  const reason =
    typeof result.reason === 'string' ? result.reason : 'no resource changes';
  if (result.status === 'no-change')
    return finish('no-change', { parents, reason });
  if (result.status !== 'proposed')
    throw new Error('Invalid reflection proposal status');
  const proposal = object(result.proposal);
  if (canonical(proposal.parentRevisionRefs) !== canonical(parents))
    throw new Error('Reflection parent revisions differ');
  const after = string(proposal.resourceRef);
  const artifacts = options.context.artifacts;
  const changedBindings = changedOwners(
    roots,
    parseFiles(await artifacts.readJson(before)),
    parseFiles(await artifacts.readJson(after)),
  );
  if (!changedBindings.length) return finish('no-change', { parents, reason });
  const revision =
    'revision-' + digest({ parentRef, after, learningId: identity });
  const permanent = await materializeRevision(options, revision, after, roots);
  const changes: Record<string, Binding> = {};
  for (const key of changedBindings) {
    const binding = options.bindings[key]!,
      config = structuredClone(binding.config);
    for (const root of roots)
      for (const member of root.members)
        if (member.binding === key)
          assignPointer(
            config,
            member.pointer,
            join(permanent, memberPath(root, member)),
          );
    validate(
      options.getDefinition(binding.plugin).configSchema,
      config,
      'Revision config',
    );
    changes[key] = { ...binding, config };
  }
  const generationReason =
    typeof result.reason === 'string'
      ? result.reason
      : 'resource changes proposed';
  await persistFact(options.context.facts, 'revisions', revision, {
    ref: revision,
    parentRef,
    rootRef: string(parent.rootRef),
    kind: 'generated',
    experimentId: options.context.experimentId,
    policyScopeId: parent.policyScopeId!,
    generationPolicyScopeId: options.invocation.policyScopeId,
    bindings,
    changedBindings,
    sourceRoots: roots,
    resourceRef: after,
    learningId: identity,
    reason: generationReason,
    status: 'validated',
  });
  const revisions = Object.fromEntries(
    changedBindings.map((key) => [key, revision]),
  );
  const prepared: JsonObject = {
    parents,
    parentRef,
    resourceRef: after,
    bindings: object(changes),
    revisions,
    reflectionRevisionRef: revision,
    reason: generationReason,
  };
  await save('validated', prepared);
  assertScope();
  await options.save(changes, revisions, identity, revision);
  return finish('activated', prepared);
}
