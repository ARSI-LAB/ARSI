import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '../../contracts/json.js';
import {
  learningFileSchema,
  type LearningKind,
  type MemoryConfiguration,
  type ReflectionConfiguration,
  type ResourceSelection,
} from '../../contracts/learning.js';
import { digest, object, string } from '../../shared/json.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { validate } from '../../shared/schema.js';
import { Binding } from '../loaders/binding.js';
import { resolveConfig } from '../loaders/config.js';
import { readYaml } from '../loaders/yaml.js';
import type { Policy } from '../policy/policy.js';
import type { Registry } from '../registry/index.js';
import { validateSnapshotDestination } from './snapshot-paths.js';
import {
  pointerValue,
  selectedResourceFields,
  validateEditableDestinations,
  type EditableRoot,
} from './resources.js';
import { compileTrigger, stepLocations } from './trigger.js';
import type {
  LearningObserve,
  MemoryConfig,
  ReflectionConfig,
} from './schema.js';
export type { MemoryConfig, ReflectionConfig } from './schema.js';
export const learningAgentBinding = '_learningAgent';

interface Resolution {
  policy: Policy;
  override?: JsonValue;
  recipeDirectory: string;
  rootDirectory?: string;
  runtimeDirectory?: string;
  bindings: Readonly<Record<string, Binding>>;
  registry: Registry;
  memoryEnabled: boolean;
}
async function regularResource(
  path: string,
  kind: 'file' | 'directory',
  label: string,
): Promise<void> {
  const info = await lstat(path).catch((cause: unknown) => {
    throw new Error(label + ': cannot read resource ' + path, { cause });
  });
  if (
    info.isSymbolicLink() ||
    !(kind === 'file' ? info.isFile() : info.isDirectory())
  )
    throw new Error(label + ': expected a regular ' + kind + ' at ' + path);
}
function checkNames(
  names: Iterable<string>,
  allowed: readonly string[],
  label: string,
): void {
  for (const name of names)
    if (!allowed.includes(name))
      throw new Error(label + ': unknown binding ' + name);
}

async function editableTargets(
  declaration: ReflectionConfiguration,
  bindings: Resolution['bindings'],
): Promise<ReflectionConfig['targets']> {
  const entries: EditableRoot[] = [];
  const targets: ReflectionConfig['targets'] = {};
  const { include, exclude } = declaration.targets ?? {};
  for (const [key, filter] of Object.entries({ include, exclude }))
    if (filter)
      checkNames(
        Object.keys(filter),
        Object.keys(bindings),
        'reflection.targets.' + key,
      );
  for (const [name, binding] of Object.entries(bindings)) {
    const schema = binding.definition.configSchema,
      config = binding.config;
    const all = configPathFields(schema, config);
    function selected(
      filter: ResourceSelection | undefined,
      fallback: boolean,
    ) {
      if (!filter || !Object.hasOwn(filter, name)) return fallback ? all : [];
      const names = filter[name];
      if (!Array.isArray(names) || names.includes('*')) {
        if (Array.isArray(names) && names.length > 1)
          throw new Error(
            'reflection.targets.' + name + ': * must appear alone',
          );
        return all;
      }
      return selectedResourceFields(schema, config, names);
    }
    const allowed = selected(include, include === undefined);
    const denied = new Set(selected(exclude, false).map((f) => f.pointer));
    const resources: string[] = [];
    for (const f of allowed) {
      const path = string(pointerValue(config, f.pointer));
      if (denied.has(f.pointer) || isResourceUrl(path)) continue;
      await regularResource(
        path,
        f.kind,
        'reflection.targets.' + name + f.pointer,
      );
      resources.push(f.pointer);
      entries.push({ ...f, path, binding: name });
    }
    if (resources.length) targets[name] = { resources };
  }
  await validateEditableDestinations(entries);
  return targets;
}

export function validateLearning(
  kind: 'memory',
  source: Resolution,
): Promise<MemoryConfig | undefined>;
export function validateLearning(
  kind: 'reflection',
  source: Resolution,
): Promise<ReflectionConfig | undefined>;
export async function validateLearning(
  kind: LearningKind,
  source: Resolution,
): Promise<MemoryConfig | ReflectionConfig | undefined> {
  const { policy, registry, bindings, override } = source;
  const fallback = policy.defaults[kind];
  if ((override ?? fallback) === false) return undefined;
  const choice = override && typeof override === 'object' ? override : fallback;
  const base =
    choice === override && typeof override === 'object'
      ? source.recipeDirectory
      : policy.resourceDirectory('/defaults/' + kind + '/configFile');
  const file =
    choice && typeof choice === 'object'
      ? resolve(base, string(object(choice).configFile))
      : undefined;
  const raw = file
    ? await readYaml(file).catch((cause: unknown) => {
        throw new Error(kind + '.configFile ' + file + ': ' + String(cause), {
          cause,
        });
      })
    : {};
  validate(learningFileSchema(kind), raw, kind + (file ? ' ' + file : ''));
  const declaration: MemoryConfiguration & ReflectionConfiguration = raw;
  const directory = file ? dirname(file) : source.recipeDirectory;
  const trigger = compileTrigger(declaration.trigger ?? {}, policy.flowIndex);
  const {
    view = 'execution',
    includeSteps,
    excludeSteps,
    includeBindings,
    excludeBindings,
  } = declaration.evidence ?? {};
  const names = Object.keys(bindings);
  const evidenceNames =
    kind === 'reflection' && source.memoryEnabled
      ? [...names, 'memory']
      : names;
  checkNames(
    includeBindings ?? [],
    evidenceNames,
    kind + '.evidence.includeBindings',
  );
  checkNames(
    excludeBindings ?? [],
    evidenceNames,
    kind + '.evidence.excludeBindings',
  );
  const paths = (ids: string[]) =>
    Array.from(
      new Set(
        ids.flatMap((id) =>
          stepLocations(policy.flowIndex, id).map((x) => x.location),
        ),
      ),
    );
  const observe: LearningObserve = {
    bindings: includeBindings ?? evidenceNames,
    ...(excludeBindings ? { excludeBindings } : {}),
    ...(includeSteps ? { steps: paths(includeSteps) } : {}),
    ...(excludeSteps ? { excludeSteps: paths(excludeSteps) } : {}),
    includeBaseline: true,
    includeCandidateDiffs: true,
  };
  const plugin = declaration.implementation?.ref ?? kind + '.agent';
  registry.assertContract(registry.contract('contract.' + kind), plugin, kind);
  const schema = registry.get(plugin).configSchema;
  const config = structuredClone(declaration.implementation?.config ?? {});
  let agentBinding: MemoryConfig['agentBinding'];
  if (config.agentRef !== undefined) {
    if (
      typeof config.agentRef !== 'string' ||
      policy.requirements[config.agentRef]?.id !== 'contract.agent'
    )
      throw new Error(
        kind +
          '.implementation.config.agentRef must select a declared contract.agent binding',
      );
  } else if (plugin === kind + '.agent') {
    const agent = Binding.resolve({
      name: learningAgentBinding,
      required: registry.contract('contract.agent'),
      registry,
      override: { declaration: { plugin: 'agent.pi' }, directory },
    });
    config.agentRef = learningAgentBinding;
    agentBinding = { plugin: agent.pluginId, config: agent.config };
  }
  if (plugin === kind + '.agent')
    config.prompt ??= fileURLToPath(
      new URL('../../plugins/' + kind + '-agent/prompt.md', import.meta.url),
    );
  validate(schema, config, kind + '.implementation.config');
  const resolvedConfig = resolveConfig(config, directory, schema);
  for (const f of configPathFields(schema, resolvedConfig)) {
    const path = string(pointerValue(resolvedConfig, f.pointer));
    if (!isResourceUrl(path))
      await regularResource(
        path,
        f.kind,
        kind + '.implementation.config' + f.pointer,
      );
  }
  const goalFile = declaration.goal
    ? resolve(directory, declaration.goal)
    : fileURLToPath(
        new URL(
          kind === 'memory'
            ? '../../plugins/memory-agent/goal.md'
            : '../../plugins/reflection-agent/goals/generic/prompt.md',
          import.meta.url,
        ),
      );
  await regularResource(goalFile, 'file', kind + '.goal');
  const goal = new TextDecoder('utf-8', { fatal: true }).decode(
    await readFile(goalFile),
  );
  if (!goal.trim()) throw new Error(kind + '.goal is empty: ' + goalFile);
  const { timeoutSeconds, ...budget } = declaration.budget ?? {};
  const common = {
    plugin,
    config: resolvedConfig,
    ...(agentBinding ? { agentBinding } : {}),
    trigger,
    observe,
    goal,
    goalFile,
    evidenceView: view,
    budget: {
      ...budget,
      ...(timeoutSeconds === undefined
        ? {}
        : { elapsedWallMs: timeoutSeconds * 1000 }),
    },
  };
  if (kind === 'memory') {
    const memory: MemoryConfiguration = declaration;
    const { include, exclude } = memory.targets ?? {};
    checkNames(include ?? [], names, 'memory.targets.include');
    checkNames(exclude ?? [], names, 'memory.targets.exclude');
    const consumers = (include ?? names).filter((n) => !exclude?.includes(n));
    const seed = memory.directory
      ? { directory: resolve(directory, memory.directory) }
      : undefined;
    if (seed)
      await validateSnapshotDestination(
        seed.directory,
        'directory',
        source.rootDirectory ?? source.recipeDirectory,
        source.runtimeDirectory,
      );
    const result = { ...common, consumers, ...(seed ? { seed } : {}) };
    return { ...result, digest: digest(result) };
  }
  const result = {
    ...common,
    targets: await editableTargets(declaration, bindings),
  };
  return { ...result, digest: digest(result) };
}
