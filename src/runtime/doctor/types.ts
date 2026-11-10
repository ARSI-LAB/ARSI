import type {
  JsonObject,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import type { Recipe } from '../loaders/recipe.js';
import type { Registry } from '../registry/index.js';

export interface DoctorCheck {
  id: string;
  binding?: string;
  pluginId?: string;
  status: 'passed' | 'failed' | 'unchecked';
  reason?: string;
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

export interface DoctorBinding {
  name: string;
  pluginId: string;
  config: JsonObject;
  definition: OperationDefinition;
}

/** Probe writes belong to directory/runtime; original Recipe resources are inputs only. */
export interface DoctorContext {
  binding: DoctorBinding;
  recipe: Recipe;
  registry: Registry;
  runtime: RuntimeContext;
  directory: string;
  signal: AbortSignal;
  /** IDs are local to this binding. Actions must release owned work after abort. */
  check(
    id: string,
    action: (signal: AbortSignal) => Promise<void>,
    options?: { timeoutMs?: number },
  ): Promise<boolean>;
  unchecked(id: string, reason: string): void;
  missing(resource: Omit<MissingResource, 'binding' | 'pluginId'>): void;
}

export type DoctorScript = (context: DoctorContext) => Promise<void>;
