import { dirname, resolve } from 'node:path';
import type {
  ArtifactStore,
  FactStore,
  WorkspaceService,
  Binding,
  JsonObject,
  RuntimeContext,
} from '../contracts/index.js';
import { object, string } from '../shared/json.js';
import { validate } from '../shared/schema.js';
import { applicationContract } from '../contracts/plugin-types/index.js';
import { Registry } from './registry/index.js';
import { Manager } from './manager/index.js';
import { registerBuiltins } from './builtins.js';
import {
  homePluginDirectories,
  loadPluginDirectories,
} from './loaders/plugins.js';
import {
  loadRecipe,
  resolveBindings,
  resolveBindingPaths,
} from './loaders/index.js';
import {
  assertSerialReflectionDependencies,
  readPolicy,
  type CompiledPolicy,
} from './compiler/index.js';
import { reflectionConfigFile } from './revisions/declaration.js';
import { validateReflection } from './revisions/validation.js';
export interface Runtime {
  context: RuntimeContext;
  manager: Manager;
  registry: Registry;
  dispose(): Promise<void>;
}
export interface RuntimeOptions {
  /** Extension home, default ~/.ember-rsi. Set false for an isolated embedded host. */
  homeDirectory?: string | false;
  /** Explicit extension directories with index.mjs exporting register(registry). Paths are relative to process.cwd(). */
  pluginDirectories?: readonly string[];
  context?: RuntimeContext;
  rootDirectory?: string;
  directory?: string;
  registry?: Registry;
  artifacts?: ArtifactStore;
  facts?: FactStore;
  workspaces?: WorkspaceService;
}
/** Embedders register additional definitions through the same Cordis registry, never a second config format. */
export async function createRuntime(
  options: RuntimeOptions = {},
): Promise<Runtime> {
  const registry = options.registry ?? new Registry();
  try {
    await registerBuiltins(registry);
    await loadPluginDirectories(registry, [
      ...(options.homeDirectory === false
        ? []
        : await homePluginDirectories(options.homeDirectory)),
      ...(options.pluginDirectories ?? []),
    ]);
  } catch (error) {
    await registry.dispose();
    throw error;
  }
  const manager = new Manager({ ...options, registry });
  registry.context.provide('rsiManager', manager);
  registry.context.provide('rsiArtifacts', manager.artifacts);
  registry.context.provide('rsiPolicyRuntime', {
    readPolicy: (path: string) => readPolicy(path, registry),
  });
  return {
    context: manager.context,
    manager,
    registry,
    async dispose() {
      await manager.dispose();
      await registry.dispose();
    },
  };
}
export async function validateRecipe(
  runtime: Runtime,
  path: string,
): Promise<JsonObject> {
  const recipe = await loadRecipe(resolve(path)),
    policy = await readPolicy(
      runtime.registry.policy(recipe.policy.ref),
      runtime.registry,
    );
  runtime.registry.assertContract(
    applicationContract,
    recipe.application.ref,
    'application',
  );
  validate(
    runtime.registry.get(recipe.application.ref).configSchema,
    recipe.application.config,
    'application.config',
  );
  resolveBindingPaths(
    recipe.application,
    runtime.registry.get(recipe.application.ref).configSchema,
    dirname(resolve(path)),
  );
  const dependencies = new Set<string>();
  async function validateGraph(
    current: CompiledPolicy,
    configuration: Binding,
    provided: Record<string, Binding>,
    stack: string[],
  ): Promise<boolean> {
    const id = string(current.definition.id);
    if (stack.includes(id) || stack.length >= 32)
      throw new Error(
        `Cyclic or excessively deep Policy dependency ${[...stack, id].join(' -> ')}`,
      );
    validate(
      typeof current.definition.config_schema === 'boolean'
        ? current.definition.config_schema
        : object(
            current.definition.config_schema ?? {
              type: 'object',
              additionalProperties: false,
            },
          ),
      configuration.config,
      `${id}.config`,
    );
    resolveBindingPaths(
      configuration,
      typeof current.definition.config_schema === 'boolean'
        ? current.definition.config_schema
        : object(current.definition.config_schema ?? {}),
      dirname(resolve(path)),
    );
    const bindings = resolveBindings(
      object(current.defaults.bindings ?? {}),
      provided,
      current.directory,
    );
    const reflectedDependencies = new Set<string>();
    for (const [name, binding] of Object.entries(bindings)) {
      if (!current.require[name])
        throw new Error(`Binding ${name} is not declared by Policy ${id}`);
      if (runtime.registry.catalog().policies.includes(binding.ref)) {
        const child = await readPolicy(
          runtime.registry.policy(binding.ref),
          runtime.registry,
        );
        runtime.registry.assertPolicyContract(
          current.require[name]!,
          child.definition,
          name,
        );
        dependencies.add(binding.ref);
        const childReflects = await validateGraph(
          child,
          binding,
          binding.bindings ?? {},
          [...stack, id],
        );
        if (childReflects) reflectedDependencies.add(name);
      } else {
        if (binding.bindings)
          throw new Error(`Plugin ${binding.ref} cannot have child bindings`);
        runtime.registry.assertContract(
          current.require[name]!,
          binding.ref,
          name,
        );
        validate(
          runtime.registry.get(binding.ref).configSchema,
          binding.config,
          `bindings.${name}.config`,
        );
        resolveBindingPaths(
          binding,
          runtime.registry.get(binding.ref).configSchema,
          dirname(resolve(path)),
        );
        dependencies.add(binding.ref);
      }
    }
    for (const name of Object.keys(current.require))
      if (!bindings[name]) throw new Error(`Missing Policy binding ${name}`);
    const declaration = current.defaults.reflection;
    const override = stack.length === 0 ? recipe.reflection : undefined;
    if (override && declaration === undefined)
      throw new Error(
        `${id}: recipe.reflection.configFile requires defaults.reflection`,
      );
    if (declaration !== undefined) {
      const selectedPath =
        override?.configFile ??
        resolve(
          current.directory,
          reflectionConfigFile(declaration, `${id}.defaults.reflection`),
        );
      const reflection = await validateReflection(
        selectedPath,
        bindings,
        (pluginId) => runtime.registry.get(pluginId),
        (contractId) => runtime.registry.contract(contractId),
      );
      dependencies.add(reflection.implementation.ref);
    }
    const callsReflectiveChild = assertSerialReflectionDependencies(
      current,
      reflectedDependencies,
    );
    return current.usesReflection || callsReflectiveChild;
  }
  await validateGraph(policy, recipe.policy, recipe.bindings, []);

  return {
    valid: true,
    recipeId: recipe.id,
    policyId: policy.definition.id!,
    plugins: [recipe.application.ref, ...dependencies],
  };
}
