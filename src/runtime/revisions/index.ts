import { collectReflectionEvidence } from './evidence.js';
import { errorText } from '../../shared/errors.js';
import {
  pointerValue,
  assignPointer,
  resourceFields,
  parseFiles,
  putFile,
  text,
  resourcePath,
  selectedResourceFields,
  validateEditableDestinations,
  type TreeFile,
  type Mapping,
} from './resources.js';
export { resourceFields } from './resources.js';
import type { ReflectionConfig } from './validation.js';
export { validateReflection } from './validation.js';
import { mkdir, readFile, lstat, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Binding,
  BudgetScope,
  RuntimeContext,
  JsonObject,
  JsonValue,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  object,
  string,
  strings,
  digest,
  canonical,
} from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { inside, safeId } from '../storage/index.js';
export type ReflectionScope = BudgetScope;
export interface ReflectionResult extends JsonObject {
  reflectionId: string;
  status: 'activated' | 'no-change' | 'skipped' | 'rejected';
  reason: string;
  revisionRefs: JsonObject;
}
export interface ReflectionOptions {
  config: ReflectionConfig;
  invocation: { policyScopeId: string; stepPath: string };
  generatorBinding: string;
  state: JsonObject;
  bindings: Record<string, Binding>;
  sourceResources?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  context: RuntimeContext;
  directory: string;
  revisionRefs: JsonObject;
  getDefinition(id: string): OperationDefinition;
  invoke(
    binding: string,
    value: JsonValue,
    key: string,
    scope: ReflectionScope,
  ): Promise<JsonValue>;
  save(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
  ): Promise<void>;
}
async function optionalFact(
  options: ReflectionOptions,
  kind: string,
  id: string,
): Promise<JsonObject | null> {
  try {
    return await options.context.facts.read(kind, id);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
async function currentRevision(
  options: ReflectionOptions,
  key: string,
  binding: Binding,
): Promise<string> {
  const active = options.revisionRefs[key];
  if (typeof active === 'string') return active;
  const ref =
    'revision-' +
    digest({
      experiment: options.context.experimentId,
      binding: key,
      policyScopeId: options.invocation.policyScopeId,
      config: binding.config,
    });
  return ref;
}
/** Confirm an activation or its descendants without rolling back a later active version. */
async function activationIncludes(
  options: ReflectionOptions,
  revisions: JsonObject,
): Promise<boolean> {
  const committed = await optionalFact(
    options,
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
      const revision = await optionalFact(options, 'revisions', ref);
      ref = revision?.parentRef;
    }
    if (ref !== expected) return false;
  }
  return true;
}
/** Execute one explicit step; save alone owns the atomic active-pointer transition. */
export async function reflect(
  options: ReflectionOptions,
): Promise<ReflectionResult> {
  options.context.signal.throwIfAborted();
  const identity =
    'reflection-' +
    digest({
      experimentId: options.context.experimentId,
      policyScopeId: options.invocation.policyScopeId,
      stepPath: options.invocation.stepPath,
    });
  const prior = await optionalFact(options, 'reflection', identity);
  const metadata: JsonObject = {
    interface: 'explicit-reflection/v1',
    reflectionId: identity,
    experimentId: options.context.experimentId,
    policyScopeId: options.invocation.policyScopeId,
    stepPath: options.invocation.stepPath,
    configFile: options.config.path,
    configDigest: options.config.digest,
  };
  if (
    prior &&
    (prior.interface !== metadata.interface ||
      prior.configFile !== metadata.configFile ||
      prior.configDigest !== metadata.configDigest)
  )
    throw new Error(
      'Reflection configuration or checkpoint is incompatible with this invocation',
    );
  const scopeStartedAt =
    typeof prior?.startedAt === 'string'
      ? prior.startedAt
      : new Date().toISOString();
  let persisted: JsonObject = prior ?? {};
  const finish = async (
    status: string,
    data: JsonObject = {},
  ): Promise<ReflectionResult> => {
    const result: ReflectionResult = {
      reflectionId: identity,
      status: terminalStatus(status),
      reason:
        status === 'rejected' && typeof data.error === 'string'
          ? data.error
          : typeof data.reason === 'string'
            ? data.reason
            : typeof data.error === 'string'
              ? data.error
              : status,
      revisionRefs: status === 'activated' ? object(data.revisions ?? {}) : {},
    };
    persisted = {
      ...persisted,
      ...data,
      ...metadata,
      startedAt: scopeStartedAt,
      status,
      reason: result.reason,
      ...(isTerminal(status) ? { result } : {}),
    };
    await options.context.facts.write('reflection', identity, persisted);
    return result;
  };
  if (prior && isTerminal(String(prior.status))) {
    const result = object(prior.result);
    const reason = result.reason;
    if (typeof reason !== 'string')
      throw new Error('Persisted Reflection result.reason: expected string');
    return {
      reflectionId: identity,
      status: terminalStatus(string(result.status)),
      reason,
      revisionRefs: object(result.revisionRefs),
    };
  }
  const elapsedLimit = options.config.budget.elapsedWallMs;
  const elapsed = Date.now() - Date.parse(scopeStartedAt);
  if (!Number.isFinite(elapsed))
    throw new Error('Invalid persisted reflection start time');
  const localTimeout =
    elapsedLimit === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(0, elapsedLimit - Math.max(0, elapsed)));
  const scope: ReflectionScope = {
    id: identity,
    signal: localTimeout
      ? AbortSignal.any([options.context.signal, localTimeout])
      : options.context.signal,
    limits: {
      ...(options.config.budget.modelCalls === undefined
        ? {}
        : { modelCalls: options.config.budget.modelCalls }),
      ...(elapsedLimit === undefined ? {} : { elapsedWallMs: elapsedLimit }),
    },
  };
  const assertScope = (): void => {
    options.context.signal.throwIfAborted();
    if (
      elapsedLimit !== undefined &&
      Date.now() - Date.parse(scopeStartedAt) >= elapsedLimit
    )
      throw new Error('Reflection local wall budget exhausted');
    scope.signal.throwIfAborted();
  };
  let workspace:
    | Awaited<ReturnType<RuntimeContext['workspaces']['create']>>
    | undefined;
  try {
    if (!prior) await finish('started');
    if (prior?.status === 'validated') {
      const changes = Object.fromEntries(
        Object.entries(object(prior.bindings)).map(([key, value]) => {
          const binding = object(value);
          return [
            key,
            { plugin: string(binding.plugin), config: object(binding.config) },
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
            (await currentRevision(options, key, binding)) !== parents[key]
          )
            throw new Error(
              'Reflection recovery conflicts with current active revisions',
            );
        }
        await options.save(changes, revisions, identity);
        Object.assign(options.revisionRefs, revisions);
      }
      return finish('activated', prior);
    }
    const collected = await collectReflectionEvidence({
      context: options.context,
      names: options.config.evidence,
      identity,
      capturedAt: scopeStartedAt,
      maxBytes: 32 * 1024 * 1024,
      policyScopeId: options.invocation.policyScopeId,
      moduleKey: options.config.path,
      configDigest: options.config.digest,
      stepPath: options.invocation.stepPath,
      directory: options.directory,
      currentRevisionRefs: options.revisionRefs,
      isAgentBinding: (name) => {
        const binding = options.bindings[name];
        if (!binding) return false;
        try {
          return (
            options.getDefinition(binding.plugin).contract.id ===
            'contract.agent'
          );
        } catch {
          return false;
        } // Policy bindings are not operation definitions.
      },
      view:
        options.config.implementation.config.evidenceView === 'training-summary'
          ? 'training-summary'
          : 'execution',
      ...(typeof prior?.evidenceViewRef === 'string'
        ? { priorRef: prior.evidenceViewRef }
        : {}),
    });
    await finish('evidence-prepared', {
      evidenceViewRef: collected.ref,
      callIds: collected.callIds,
    });
    const evidenceRefs = collected.ref ? [collected.ref] : [];
    workspace = await options.context.workspaces.create();
    const parents: JsonObject = {},
      manifest: JsonObject = {},
      mappings = new Map<string, Mapping>();
    // A prepared boundary must replay the same generator input and resource snapshot.
    const legacyEditLimits =
      prior?.status === 'prepared' &&
      Object.hasOwn(
        object(object(prior.input).editConstraints),
        'maxChangedFiles',
      );
    const projected = new Map<string, TreeFile>();
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
        fields = resourceFields(plugin.configSchema, binding.config);
      const parent = await currentRevision(options, key, binding);
      parents[key] = parent;
      const parentFact = await optionalFact(options, 'revisions', parent);
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
          ...(legacyEditLimits ? { maxBytes: 65536 } : {}),
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
    await putFile(workspace.directory, 'manifest.json', canonical(manifest));
    const before = await options.context.artifacts.capture(workspace.directory);
    for (const key of Object.keys(options.config.targets)) {
      const parent = string(parents[key]);
      if (await optionalFact(options, 'revisions', parent)) continue;
      const binding = options.bindings[key]!;
      await options.context.facts.write('revisions', parent, {
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
    // Publish initial pointers only after every target snapshot is durable.
    for (const [key, parent] of Object.entries(parents))
      if (options.revisionRefs[key] === undefined)
        options.revisionRefs[key] = parent;
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
        ...(legacyEditLimits
          ? { maxChangedFiles: 16, maxChangedBytes: 131072 }
          : {}),
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
      await finish('prepared', {
        startedAt: scopeStartedAt,
        parents,
        resourceRef: before,
        input,
        callIds: collected.callIds,
        evidenceViewRef: collected.ref,
      });
    assertScope();
    if (
      options.config.implementation.ref === 'reflection.agent' &&
      scope.limits.modelCalls === 0
    )
      throw new Error('Reflection local model-call budget exhausted');
    const result = object(
      await options.invoke(
        options.generatorBinding,
        input,
        `reflection/${identity}`,
        scope,
      ),
    );
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
    let total = 0,
      changedFiles = 0;
    // Windows also reports 0666 for writable files created with 0644.
    const textModes = process.platform === 'win32' ? [0o644, 0o666] : [0o644];
    for (const path of new Set([...oldTree.keys(), ...newTree.keys()])) {
      const a = oldTree.get(path),
        b = newTree.get(path);
      if (canonical(a ?? null) === canonical(b ?? null)) continue;
      changedFiles++;
      if (legacyEditLimits && changedFiles > 16)
        throw new Error('Reflection exceeds changed-file limit');
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
      if (b && !textModes.includes(b.mode & 0o777))
        throw new Error('Reflection resource mode change denied');
      const bytes = b ? Buffer.from(b.base64, 'base64').length : 0;
      total += bytes;
      if (legacyEditLimits && (bytes > 65536 || total > 131072))
        throw new Error('Reflection resource exceeds byte limit');
      if (b) text(b);
    }
    for (const [path, mapping] of mappings) {
      if (mapping.maxBytes === undefined) continue;
      const size = [...newTree]
        .filter(([file]) =>
          path.endsWith('/') ? file.startsWith(path) : file === path,
        )
        .reduce(
          (sum, [, file]) => sum + Buffer.from(file.base64, 'base64').length,
          0,
        );
      if (size > mapping.maxBytes)
        throw new Error('Reflection resource exceeds aggregate byte limit');
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
      for (const field of resourceFields(plugin.configSchema, config)) {
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
        options,
        'revisions',
        string(parents[key]),
      );
      await options.context.facts.write('revisions', revision, {
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
        reflectionId: identity,
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
    await finish('validated', prepared);
    assertScope();
    await options.save(changes, revisions, identity);
    Object.assign(options.revisionRefs, revisions);
    return finish('activated', prepared);
  } catch (error) {
    const saved = await optionalFact(options, 'reflection', identity);
    if (
      saved?.status === 'validated' &&
      (await activationIncludes(options, object(saved.revisions)))
    ) {
      const result = await finish('activated', saved);
      options.context.signal.throwIfAborted();
      return result;
    }
    const result = await finish('rejected', {
      ...saved,
      error: errorText(error),
      parentRevisionRefs: prior?.parents ?? null,
    });
    if (
      options.context.signal.aborted ||
      (error instanceof Error && error.name === 'ExperimentBudgetExceeded')
    )
      throw error;
    return result;
  } finally {
    if (workspace) await options.context.workspaces.release(workspace.ref);
  }
}
function isTerminal(status: string): boolean {
  return ['activated', 'no-change', 'rejected', 'skipped'].includes(status);
}
function terminalStatus(status: string): ReflectionResult['status'] {
  if (
    status === 'activated' ||
    status === 'no-change' ||
    status === 'skipped' ||
    status === 'rejected'
  )
    return status;
  return 'rejected';
}
