import { resolve } from 'node:path';
import type {
  ArtifactStore,
  FactStore,
  WorkspaceService,
  JsonObject,
  RuntimeContext,
} from '../contracts/index.js';
import { Registry } from './registry/index.js';
import { Manager } from './manager/index.js';
import { registerBuiltins } from './builtins.js';
import {
  homePluginDirectories,
  loadPluginDirectories,
} from './loaders/plugins.js';
import { Recipe } from './loaders/recipe.js';
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
  const recipe = await Recipe.load(resolve(path), runtime.registry);
  return {
    valid: true,
    recipeId: recipe.id,
    policyId: recipe.policy.id,
    plugins: [
      ...new Set([
        recipe.application.pluginId,
        ...Object.values(recipe.bindings).map((binding) => binding.pluginId),
        ...(recipe.reflection ? [recipe.reflection.implementation.ref] : []),
      ]),
    ],
  };
}
