import type { JsonObject, JsonValue } from '../../contracts/index.js';
import type { Policy, PolicyOptions } from './policy.js';
export { Policy } from './policy.js';
export { evaluateTemplate } from './expression.js';
export {
  InvokeStep,
  StateStep,
  IfStep,
  LoopStep,
  ForEachStep,
  ControlStep,
  ReflectionStep,
  type Step,
  type StepType,
  type StepResult,
  type StepBlock,
  type StepContext,
  type StepValidationContext,
  type ControlAction,
  type Template,
} from './steps.js';
export type { PolicyOptions } from './policy.js';
/** Programmatic convenience entrypoint; all execution uses the unified Policy model. */
export async function executePolicy(
  policy: Policy,
  input: JsonObject,
  config: JsonObject,
  options: Omit<PolicyOptions, 'input' | 'config'>,
): Promise<JsonValue> {
  return policy.execute({ ...options, input, config });
}
