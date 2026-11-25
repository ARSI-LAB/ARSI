export {
  createRuntime,
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
  runtimeEvolutionNames,
  runtimeEvolutionTriggerSchema,
  runtimeEvolutionDeclarationSchema,
  runtimeEvolutionFileSchema,
} from './contracts/runtime-evolution.js';
export {
  prepareAgentProject,
  type AgentRole,
} from './plugins/shared/agent-editing/project.js';

export { Recipe } from './runtime/loaders/recipe.js';
export { Binding } from './runtime/loaders/binding.js';
export {
  InvokeStep,
  StateStep,
  IfStep,
  LoopStep,
  ForEachStep,
  ControlStep,
} from './runtime/policy/steps.js';

// Extensions can request edits without committing candidates before domain validation.
export {
  requestEdit,
  agentConfigSchema,
} from './plugins/shared/agent-editing/index.js';
