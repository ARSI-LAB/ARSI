import type { JsonObject } from './json.js';

export interface Binding {
  ref: string;
  config: JsonObject;
  bindings?: Record<string, Binding>;
}
export interface Recipe {
  schemaVersion: 'rsi.recipe/v1';
  id: string;
  application: Binding;
  policy: { ref: string; config: JsonObject; input: JsonObject };
  bindings: Record<string, Binding>;
  budget: Record<string, number>;
  reflection?: { configFile: string };
}
