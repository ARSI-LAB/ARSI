import type { Registry } from '../registry/index.js';
import { Recipe } from './recipe.js';

export { Binding } from './binding.js';
export type { BindingSource, ResolveBindingOptions } from './binding.js';
export { Recipe } from './recipe.js';
export type { RecipeLoadOptions } from './recipe.js';
export { readYaml } from './yaml.js';
export { resolveConfig } from './config.js';

export async function loadRecipe(
  path: string,
  registry: Registry,
): Promise<Recipe> {
  return Recipe.load(path, registry);
}
