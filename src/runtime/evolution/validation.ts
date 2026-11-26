import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '../../contracts/json.js';
import {
  runtimeEvolutionFileSchema,
  type RuntimeEvolutionKind,
  type MemoryConfiguration,
  type ReflectionConfiguration,
} from '../../contracts/runtime-evolution.js';
import { digest, object, string } from '../../shared/json.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { Binding } from '../loaders/binding.js';
import { resolveConfig } from '../loaders/config.js';
import { readYaml } from '../loaders/yaml.js';
import type { Policy } from '../policy/policy.js';
import type { Registry } from '../registry/index.js';
import { validateSnapshotDestination } from './snapshot-paths.js';
import {
  pointerValue,
  selectedResourceFields,
  resolveCoveringRoots,
  type EditableRoot,
} from './resources.js';
import { compileTrigger, stepLocations } from './trigger.js';
import type {
  RuntimeEvolutionObserve,
  MemoryConfig,
  ReflectionConfig,
} from './schema.js';
export type { MemoryConfig, ReflectionConfig } from './schema.js';
export const evolutionAgentBinding = '_evolutionAgent';

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
  const { include, exclude } = declaration.targets;
  for (const [key, filter] of Object.entries({ include, exclude }))
    if (filter)
      checkNames(
        Object.keys(filter),
        Object.keys(bindings),
        'reflection.targets.' + key,
      );
  for (const [name, selection] of Object.entries(include)) {
    const { definition, config } = bindings[name];
    const schema = definition.configSchema;
    const wildcard = selection === '*' || selection[0] === '*';
    const allowed = wildcard
      ? configPathFields(schema, config).filter(
          (f) => !isResourceUrl(f.reference),
        )
      : selectedResourceFields(schema, config, selection);
    if (!allowed.length)
      throw new Error(
        `reflection.targets.include.${name}: no local x-rsi-path resources`,
      );
    const omitted = exclude?.[name];
    const omitBinding = omitted === '*' || omitted?.[0] === '*';
    const denied = new Set(
      Array.isArray(omitted) && !omitBinding
        ? selectedResourceFields(schema, config, omitted).map((f) => f.pointer)
        : [],
    );
    const resources: string[] = [];
    for (const f of allowed) {
      const path = f.reference;
      if (isResourceUrl(path))
        throw new Error(
          `reflection.targets.include.${name}${f.pointer}: cannot edit a remote URL`,
        );
      if (omitBinding || denied.has(f.pointer)) continue;
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
  if (!entries.length)
    throw new Error(
      'reflection.targets must select at least one editable resource',
    );
  await resolveCoveringRoots(entries);
  return targets;
}

export function validateRuntimeEvolution(
  kind: 'memory',
  source: Resolution,
): Promise<MemoryConfig | undefined>;
export function validateRuntimeEvolution(
  kind: 'reflection',
  source: Resolution,
): Promise<ReflectionConfig | undefined>;
export async function validateRuntimeEvolution(
  kind: RuntimeEvolutionKind,
  source: Resolution,
): Promise<MemoryConfig | ReflectionConfig | undefined> {
  const { policy, registry, bindings, override } = source;
  const fallback = policy.defaults[kind];
  const enabled = override ?? fallback;
  if (enabled === false || (kind === 'reflection' && enabled === undefined))
    return undefined;
  const choice = override && typeof override === 'object' ? override : fallback;
  const base =
    choice === override && typeof override === 'object'
      ? source.recipeDirectory
      : policy.resourceDirectory('/defaults/' + kind + '/configFile');
  const file =
    choice && typeof choice === 'object'
      ? resolve(base, string(object(choice).configFile))
      : undefined;
  if (kind === 'reflection' && !file)
    throw new Error(
      'reflection requires a configFile declaring targets.include; provide reflection: { configFile } in the Recipe or Policy defaults',
    );
  const raw = file
    ? await readYaml(file).catch((cause: unknown) => {
        throw new Error(kind + '.configFile ' + file + ': ' + String(cause), {
          cause,
        });
      })
    : {};
  const fileSchema = runtimeEvolutionFileSchema(kind);
  const label = kind + (file ? ' ' + file : '');
  const parsed =
    kind === 'memory'
      ? {
          kind,
          declaration: parseConfig<MemoryConfiguration>(fileSchema, raw, label),
        }
      : {
          kind,
          declaration: parseConfig<ReflectionConfiguration>(
            fileSchema,
            raw,
            label,
          ),
        };
  const { declaration } = parsed;
  const directory = file ? dirname(file) : source.recipeDirectory;
  const trigger = compileTrigger(declaration.trigger ?? {}, policy.flowIndex);
  const {
    view = 'training',
    includeSteps,
    excludeSteps,
    includeBindings,
    excludeBindings,
  } = declaration.evidence ?? {};
  const names = Object.keys(bindings);
  const evidenceNames = kind === 'reflection' ? [...names, 'memory'] : names;
  const availableNames = source.memoryEnabled ? evidenceNames : names;
  checkNames(
    includeBindings ?? [],
    availableNames,
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
  const observe: RuntimeEvolutionObserve = {
    bindings: includeBindings ?? availableNames,
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
    const declaredAgents = Object.keys(policy.requirements).filter(
      (name) => policy.requirements[name].id === 'contract.agent',
    );
    if (declaredAgents.length === 1) {
      config.agentRef = declaredAgents[0];
    } else {
      const agent = Binding.resolve({
        name: evolutionAgentBinding,
        required: registry.contract('contract.agent'),
        registry,
        override: { declaration: { plugin: 'agent.pi' }, directory },
      });
      config.agentRef = evolutionAgentBinding;
      agentBinding = { plugin: agent.pluginId, config: agent.config };
    }
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
  if (parsed.kind === 'memory') {
    const memory = parsed.declaration;
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
    targets: await editableTargets(parsed.declaration, bindings),
  };
  return { ...result, digest: digest(result) };
}
