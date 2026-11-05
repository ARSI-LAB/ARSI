import type { JsonObject, JsonSchema } from './json.js';

/** A declaration may inherit its plugin and individual configuration fields. */
export interface BindingDeclaration {
  plugin?: string;
  config?: JsonObject;
}

/** The serializable form of one complete plugin binding. */
export interface Binding {
  plugin: string;
  config: JsonObject;
}

export interface RecipeDeclaration {
  schemaVersion: 'rsi.recipe/v1';
  id: string;
  description?: string;
  application: { plugin: string; config?: JsonObject };
  policy: { id: string; config?: JsonObject; input?: JsonObject };
  bindings?: Record<string, BindingDeclaration>;
  budget?: Record<string, number>;
  reflection?: { configFile: string };
}

/** A normalized declaration, without runtime instances or executable definitions. */
export interface Recipe extends RecipeDeclaration {
  application: Binding;
  policy: { id: string; config: JsonObject; input: JsonObject };
  bindings: Record<string, Binding>;
  budget: Record<string, number>;
}

export const bindingDeclarationSchema: JsonSchema = {
  type: 'object',
  properties: {
    plugin: { type: 'string', minLength: 1 },
    config: { type: 'object' },
  },
  additionalProperties: false,
};

export const recipeDeclarationSchema: JsonSchema = {
  type: 'object',
  properties: {
    schemaVersion: { const: 'rsi.recipe/v1' },
    id: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    application: {
      ...bindingDeclarationSchema,
      required: ['plugin'],
    },
    policy: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        config: { type: 'object' },
        input: { type: 'object' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    bindings: {
      type: 'object',
      additionalProperties: bindingDeclarationSchema,
    },
    budget: {
      type: 'object',
      additionalProperties: { type: 'number', minimum: 0 },
    },
    reflection: {
      type: 'object',
      properties: { configFile: { type: 'string', minLength: 1 } },
      required: ['configFile'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'id', 'application', 'policy'],
  additionalProperties: false,
};
