export {
  createRuntime,
  validateRecipe,
  type Runtime,
  type RuntimeOptions,
} from './runtime/context.js';
export { Registry } from './runtime/registry/index.js';
export { Manager } from './runtime/manager/index.js';
export {
  Policy,
  evaluateTemplate,
  type ContractResolver,
  type PolicyOptions,
} from './runtime/policy/index.js';
export { defineContract } from './contracts/contract.js';
export { RuntimeContext } from './contracts/runtime/context.js';
export * from './contracts/plugin-types/index.js';
export type * from './contracts/index.js';
export {
  prepareAgentProject,
  projectMarker,
  type AgentRole,
} from './plugins/shared/agent-editing/project.js';

export { Recipe } from './runtime/loaders/recipe.js';
export { Binding } from './runtime/loaders/binding.js';
// Stable surface for external plugin packs (--plugin-dir): they import
// dist/src/index.js by file URL and must only rely on exports from this module.
export { json, object } from './shared/json.js';
export {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from './shared/schema.js';
export {
  InvokeStep,
  StateStep,
  IfStep,
  LoopStep,
  ForEachStep,
  ControlStep,
  ReflectionStep,
} from './runtime/policy/steps.js';
