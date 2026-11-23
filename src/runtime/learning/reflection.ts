import { persistFact } from '../storage/persistence-error.js';
import {
  runLearningCycle,
  optionalFact,
  type CycleOptions,
  type LearningCycle,
} from './runner.js';
import type { LearningResult } from './records.js';
import {
  pointerValue,
  assignPointer,
  resourcePath,
  selectedResourceFields,
  validateEditableDestinations,
} from './resources.js';
import type { ReflectionConfig } from './validation.js';
import { mkdir, readFile, lstat, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Binding,
  FileTreeFile,
  RuntimeContext,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import {
  object,
  string,
  strings,
  digest,
  canonical,
} from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { configPathFields } from '../../shared/paths.js';
import { inside, safeId } from '../storage/index.js';
type Mapping = {
  kind: string;
  binding: string;
  pointer: string;
  changes: JsonValue[];
};
export interface ReflectionOptions extends CycleOptions {
  config: ReflectionConfig;
  sourceResources?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Publish initial parents only after every target snapshot is durable. */
  initialize(parents: JsonObject): void;
  save(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
  ): Promise<void>;
}
function parseFiles(value: JsonValue): Map<string, FileTreeFile> {
  return new Map(parseFileTree(value).files.map((file) => [file.path, file]));
}
function text(file: FileTreeFile): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(file.base64, 'base64'),
  );
}
function currentRevision(
  options: ReflectionOptions,
  key: string,
  binding: Binding,
): string {
  const active = options.revisionRefs[key];
  if (typeof active === 'string') return active;
  return (
    'revision-' +
    digest({
      experiment: options.context.experimentId,
      binding: key,
      policyScopeId: options.invocation.policyScopeId,
      config: binding.config,
    })
  );
}
/** Confirm an activation or its descendants without rolling back a later active version. */
async function activationIncludes(
  options: ReflectionOptions,
  revisions: JsonObject,
): Promise<boolean> {
  const committed = await optionalFact(
    options.context.facts,
    'activations',
    options.context.experimentId,
  );
  if (!committed) return false;
  const current = object(committed.revisions ?? {});
  for (const [key, expected] of Object.entries(revisions)) {
    let ref: JsonValue | undefined = current[key];
    const visited = new Set<string>();
    while (typeof ref === 'string' && ref !== expected && !visited.has(ref)) {
      visited.add(ref);
      const revision = await optionalFact(
        options.context.facts,
        'revisions',
        ref,
      );
      ref = revision?.parentRef;
    }
    if (ref !== expected) return false;
  }
  return true;
}
/** Prepare authorized target resources, validate the proposal and publish revisions together. */
export async function reflect(
  options: ReflectionOptions,
): Promise<LearningResult> {
  return runLearningCycle(options, 'reflection', {
    includes: (record) => activationIncludes(options, object(record.revisions)),
    parentsMatch: (record) =>
      Object.entries(object(record.parents)).every(([key, parent]) => {
        const binding = options.bindings[key];
        return binding && currentRevision(options, key, binding) === parent;
      }),
    execute: (cycle) => reviseResources(options, cycle),
  });
}

async function reviseResources(
  options: ReflectionOptions,
  cycle: LearningCycle,
): Promise<LearningResult> {
  const { prior, identity, assertScope, save, finish } = cycle;
  let workspace:
    | Awaited<ReturnType<RuntimeContext['workspaces']['create']>>
    | undefined;
  try {
    if (prior?.status === 'validated') {
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
      const revisions = object(prior.revisions);
      if (!(await activationIncludes(options, revisions))) {
        assertScope();
        const parents = object(prior.parents);
        for (const key of Object.keys(revisions)) {
          const binding = options.bindings[key];
          if (
            !binding ||
            currentRevision(options, key, binding) !== parents[key]
          )
            throw new Error(
              'Reflection recovery conflicts with current active revisions',
            );
        }
        await options.save(changes, revisions, identity);
      }
      return finish('activated', prior);
    }
    const collected = await cycle.evidence();
    const evidenceRefs = collected.ref ? [collected.ref] : [];
    if (!Object.keys(options.config.targets).length)
      return finish('skipped', { reason: 'no editable resources' });
    workspace = await options.context.workspaces.create();
    const parents: JsonObject = {},
      manifest: JsonObject = {},
      mappings = new Map<string, Mapping>();
    // A prepared boundary must replay the same generator input and resource snapshot.
    const projected = new Map<string, FileTreeFile>();
    const originals = new Map<string, JsonObject[]>();
    const register = (path: string, mapping: Mapping): void => {
      if (mappings.has(path))
        throw new Error('Duplicate reflection authorization');
      mappings.set(path, mapping);
      manifest[path] = mapping;
    };
    for (const key of Object.keys(options.config.targets)) {
      safeId(key);
      const binding = options.bindings[key];
      if (!binding) throw new Error(`Unknown reflection target ${key}`);
      const plugin = options.getDefinition(binding.plugin),
        fields = configPathFields(plugin.configSchema, binding.config);
      const parent = currentRevision(options, key, binding);
      parents[key] = parent;
      const parentFact = await optionalFact(
        options.context.facts,
        'revisions',
        parent,
      );
      const selectedFields = selectedResourceFields(
        plugin.configSchema,
        binding.config,
        options.config.targets[key]!.resources,
      );
      const sourceResources = Array.isArray(parentFact?.sourceResources)
        ? parentFact.sourceResources.map((value) => object(value))
        : selectedFields.map((field) => ({
            pointer: field.pointer,
            kind: field.kind,
            path:
              options.sourceResources?.[key]?.[field.pointer] ??
              string(pointerValue(binding.config, field.pointer)),
            artifactPath: resourcePath(key, field.pointer),
          }));
      originals.set(key, sourceResources);
      if (typeof parentFact?.resourceRef === 'string') {
        const priorTree = parseFiles(
          await options.context.artifacts.readJson(parentFact.resourceRef),
        );
        for (const [path, file] of priorTree)
          if (path.startsWith(`bindings/${key}/resources/`))
            projected.set(path, file);
      }
      for (const field of fields) {
        if (typeof parentFact?.resourceRef === 'string') continue;
        const path = resourcePath(key, field.pointer),
          exists = [...projected.keys()].some(
            (p) => p === path || p.startsWith(path + '/'),
          );
        if (exists) continue;
        const source = string(pointerValue(binding.config, field.pointer));
        if (field.kind === 'file') {
          const bytes = await readFile(source),
            info = await lstat(source);
          projected.set(path, {
            path,
            base64: bytes.toString('base64'),
            mode: info.mode & 0o777,
          });
        } else {
          const tree = parseFiles(
            await options.context.artifacts.readJson(
              await options.context.artifacts.capture(source),
            ),
          );
          for (const [local, file] of tree)
            projected.set(`${path}/${local}`, {
              ...file,
              path: `${path}/${local}`,
            });
        }
      }
      for (const field of selectedFields) {
        const pointer = field.pointer;
        const path =
          resourcePath(key, pointer) + (field.kind === 'directory' ? '/' : '');
        register(path, {
          kind: field.kind,
          binding: key,
          pointer,
          changes: ['create', 'modify'],
        });
      }
    }
    await validateEditableDestinations(
      [...originals].flatMap(([binding, resources]) =>
        resources.map((resource) => ({
          binding,
          pointer: string(resource.pointer),
          kind: resource.kind === 'file' ? 'file' : 'directory',
          path: string(resource.path),
        })),
      ),
    );
    for (const [path, file] of projected) {
      const destination = inside(workspace.directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.base64, 'base64'), {
        mode: file.mode,
      });
      await chmod(destination, file.mode);
    }
    await writeFile(
      join(workspace.directory, 'manifest.json'),
      canonical(manifest),
      { mode: 0o644 },
    );
    const before = await options.context.artifacts.capture(workspace.directory);
    for (const key of Object.keys(options.config.targets)) {
      const parent = string(parents[key]);
      if (await optionalFact(options.context.facts, 'revisions', parent))
        continue;
      const binding = options.bindings[key]!;
      await persistFact(options.context.facts, 'revisions', parent, {
        ref: parent,
        parentRef: null,
        rootRef: parent,
        kind: 'initial',
        experimentId: options.context.experimentId,
        policyScopeId: options.invocation.policyScopeId,
        binding: key,
        pluginRef: binding.plugin,
        pluginId: binding.plugin,
        config: binding.config,
        sourceResources: originals.get(key)!,
        resourceRef: before,
      });
    }
    options.initialize(parents);
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
      evidenceRefs,
      editConstraints: {
        allowedPaths: [...mappings.keys()].map((path) =>
          path.endsWith('/') ? path + '**/*' : path,
        ),
      },
    };
    if (prior?.status === 'prepared') {
      if (
        canonical(prior.parents) !== canonical(parents) ||
        prior.resourceRef !== before ||
        canonical(prior.input) !== canonical(input)
      )
        throw new Error('Prepared Reflection input changed before recovery');
    } else
      await save('prepared', {
        parents,
        resourceRef: before,
        input,
        callIds: collected.callIds,
        evidenceViewRef: collected.ref,
      });
    assertScope();
    const result = object(await cycle.invoke(input));
    assertScope();
    if (result.status === 'no-change') {
      return finish('no-change', {
        parents,
        reason:
          typeof result.reason === 'string'
            ? result.reason
            : 'no resource changes',
      });
    }
    if (result.status !== 'proposed')
      throw new Error('Invalid reflection proposal status');
    const generationReason =
      typeof result.reason === 'string'
        ? result.reason
        : 'resource changes proposed';
    const proposal = object(result.proposal);
    if (canonical(proposal.parentRevisionRefs) !== canonical(parents))
      throw new Error('Reflection parent revisions differ');
    const after = string(proposal.resourceRef),
      oldTree = parseFiles(await options.context.artifacts.readJson(before)),
      newTree = parseFiles(await options.context.artifacts.readJson(after));
    const changedTargets = new Set<string>();
    let changedFiles = 0;
    for (const path of new Set([...oldTree.keys(), ...newTree.keys()])) {
      const a = oldTree.get(path),
        b = newTree.get(path);
      if (canonical(a ?? null) === canonical(b ?? null)) continue;
      changedFiles++;
      const mapping =
        mappings.get(path) ??
        [...mappings].find(
          ([prefix]) => prefix.endsWith('/') && path.startsWith(prefix),
        )?.[1];
      if (!mapping || path === 'manifest.json')
        throw new Error('Reflection edit outside authorized resource');
      changedTargets.add(mapping.binding);
      const change = !a ? 'create' : !b ? 'delete' : 'modify';
      if (!strings(mapping.changes).includes(change))
        throw new Error(`Reflection ${change} denied`);
      // Content edits preserve existing permissions; new text files may follow umask.
      if (b && ((b.mode & 0o111) !== 0 || (a && b.mode !== a.mode)))
        throw new Error('Reflection resource mode change denied');
      if (b) text(b);
    }
    if (changedFiles === 0) {
      return finish('no-change', {
        parents,
        reason:
          typeof result.reason === 'string'
            ? result.reason
            : 'no resource changes',
      });
    }
    const changes: Record<string, Binding> = {},
      revisions: JsonObject = {},
      permanent = join(
        options.directory,
        'experiments',
        options.context.experimentId,
        'revisions',
        digest({ after, parents }),
      );
    await mkdir(permanent, { recursive: true });
    let retained = false;
    try {
      retained =
        (await options.context.artifacts.capture(
          join(permanent, 'resources'),
        )) === after;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    try {
      if (!retained)
        await options.context.artifacts.materialize(
          after,
          join(permanent, 'resources'),
        );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
    for (const key of Object.keys(options.config.targets)) {
      if (!changedTargets.has(key)) continue;
      const binding = options.bindings[key]!,
        plugin = options.getDefinition(binding.plugin);
      const config = structuredClone(binding.config);
      for (const field of configPathFields(plugin.configSchema, config)) {
        const path = resourcePath(key, field.pointer);
        if (field.kind === 'file' && !newTree.has(path))
          throw new Error(`Required resource ${field.pointer} removed`);
        const resourceDirectory = join(permanent, 'resources', path);
        if (field.kind === 'directory')
          await mkdir(resourceDirectory, { recursive: true });
        assignPointer(config, field.pointer, resourceDirectory);
      }
      validate(plugin.configSchema, config, 'Revision config');
      const revision =
        'revision-' +
        digest({ binding: key, parent: parents[key], after, config });
      revisions[key] = revision;
      changes[key] = { ...binding, config };
      const parentRevision = await optionalFact(
        options.context.facts,
        'revisions',
        string(parents[key]),
      );
      await persistFact(options.context.facts, 'revisions', revision, {
        ref: revision,
        parentRef: parents[key]!,
        experimentId: options.context.experimentId,
        binding: key,
        // A qualified binding retains its activated resource chain across Policy invocations.
        policyScopeId:
          parentRevision?.policyScopeId ?? options.invocation.policyScopeId,
        generationPolicyScopeId: options.invocation.policyScopeId,
        kind: 'generated',
        rootRef: parentRevision?.rootRef ?? parents[key]!,
        sourceResources: originals.get(key)!,
        pluginRef: binding.plugin,
        pluginId: binding.plugin,
        config,
        resourceRef: after,
        learningId: identity,
        reason: generationReason,
        status: 'validated',
      });
    }
    const prepared: JsonObject = {
      parents,
      resourceRef: after,
      bindings: object(JSON.parse(JSON.stringify(changes))),
      revisions,
      reason: generationReason,
    };
    await save('validated', prepared);
    assertScope();
    await options.save(changes, revisions, identity);
    return finish('activated', prepared);
  } finally {
    if (workspace) await options.context.workspaces.release(workspace.ref);
  }
}
