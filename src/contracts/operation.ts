import type { JsonObject, JsonSchema, JsonValue } from './json.js';
import type { PluginContract } from './contract.js';
import type { RuntimeContext } from './runtime/context.js';

/** A concrete plugin uses the input and output types owned by its public contract. */
export interface Operation<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> {
  execute(input: I, context: RuntimeContext): Promise<O>;
  /** Read-only reconciliation for a failed or cancelled receipt. Return true only
   * when replay cannot duplicate effects. The Runtime archives the prior receipt
   * and charges the retry normally. */
  canRetry?(
    input: I,
    receipt: JsonObject,
    context: RuntimeContext,
  ): Promise<boolean>;
  dispose(): Promise<void>;
}
/** C describes supplied configuration; fields with Schema defaults may be optional. */
export interface OperationDefinition<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
  C extends JsonObject = JsonObject,
> {
  id: string;
  description?: string;
  implementationDigest?: string;
  contract: PluginContract;
  configSchema: JsonSchema;
  create(config: C, context: RuntimeContext): Promise<Operation<I, O>>;
}
