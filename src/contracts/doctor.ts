import type { PluginContract } from './contract.js';
import type { JsonObject } from './json.js';
import type { OperationDefinition } from './operation.js';
import type { RuntimeContext } from './runtime/context.js';

export interface DoctorCheck {
  id: string;
  binding?: string;
  pluginId?: string;
  status: 'passed' | 'failed' | 'unchecked';
  reason?: string;
  /** Observations establish only the scope described by this check. */
  details?: JsonObject;
}

export interface MissingResource {
  binding: string;
  pluginId: string;
  field: string;
  kind: string;
  reference: string;
  checksNotRun: string[];
}

export interface DoctorReport {
  recipeId: string | null;
  summary: { passed: number; failed: number; unchecked: number };
  missingResources: MissingResource[];
  checks: DoctorCheck[];
}

export interface DoctorBinding<C extends JsonObject = JsonObject> {
  readonly name: string;
  readonly pluginId: string;
  readonly config: C;
  readonly definition: OperationDefinition;
}

/** Effective bindings and Policy configuration; no experiment instance is created. */
export interface DoctorRecipe {
  readonly application: DoctorBinding;
  readonly bindings: Readonly<Record<string, DoctorBinding>>;
  readonly policyConfig: JsonObject;
}

/** Registration queries available to diagnostics without a concrete Registry dependency. */
export interface DoctorRegistry {
  get(id: string): OperationDefinition;
  assertContract(
    required: PluginContract,
    pluginId: string,
    binding: string,
  ): void;
}

/** The runner owns temporary storage, deadlines, result aggregation and redaction. */
export interface DoctorContext<C extends JsonObject = JsonObject> {
  readonly binding: DoctorBinding<C>;
  readonly recipe: DoctorRecipe;
  readonly registry: DoctorRegistry;
  readonly runtime: RuntimeContext;
  readonly directory: string;
  readonly signal: AbortSignal;
  /** IDs are local to this binding; propagate this action's signal and release owned work. */
  check(
    id: string,
    action: (signal: AbortSignal) => Promise<void>,
    options?: { timeoutMs?: number; reason?: string; details?: JsonObject },
  ): Promise<boolean>;
  unchecked(id: string, reason: string, details?: JsonObject): void;
  missing(resource: Omit<MissingResource, 'binding' | 'pluginId'>): void;
}

/** Optional preflight capability; never invoked by registration or experiment execution. */
export type OperationDoctor<C extends JsonObject = JsonObject> = (
  context: DoctorContext<C>,
) => Promise<void>;
