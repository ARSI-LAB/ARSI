import type { Binding as BindingData } from '../../contracts/recipe.js';
import { bindingDeclarationSchema } from '../../contracts/recipe.js';
import type { JsonObject, JsonValue } from '../../contracts/json.js';
import type { PluginContract } from '../../contracts/contract.js';
import type { OperationDefinition } from '../../contracts/operation.js';
import { object, string, freezeSnapshot } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import { resolvePaths } from './config.js';

export interface BindingSource {
  /** Raw declaration data is validated before any internal merge. */
  declaration: unknown;
  directory: string;
}

export interface ResolveBindingOptions {
  name: string;
  required: PluginContract;
  registry: Registry;
  defaults?: BindingSource;
  override?: BindingSource;
}

const pointerPart = (part: string): string =>
  part.replaceAll('~', '~0').replaceAll('/', '~1');
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Assembly owns configuration; plugin instances and their lifecycle belong to Runtime. */
export class Binding {
  readonly name: string;
  readonly definition: OperationDefinition;
  readonly config: JsonObject;

  private constructor(
    name: string,
    definition: OperationDefinition,
    config: JsonObject,
  ) {
    this.name = name;
    this.definition = Object.freeze({
      ...definition,
      contract: freezeSnapshot(structuredClone(definition.contract)),
      configSchema: freezeSnapshot(structuredClone(definition.configSchema)),
    });
    this.config = freezeSnapshot(config);
    Object.freeze(this);
  }

  get pluginId(): string {
    return this.definition.id;
  }

  static resolve(options: ResolveBindingOptions): Binding {
    const { name, required, registry } = options;
    const label = `Binding ${name}`;
    const parse = (
      source: BindingSource | undefined,
      kind: string,
    ): JsonObject => {
      if (!source) return {};
      const declaration = object(
        structuredClone(source.declaration),
        `${label} ${kind}`,
      );
      validate(bindingDeclarationSchema, declaration, `${label} ${kind}`);
      return declaration;
    };
    const defaults = parse(options.defaults, 'default');
    const override = parse(options.override, 'override');
    const pluginId = string(
      override.plugin ?? defaults.plugin,
      `${label}.plugin`,
    );
    try {
      registry.assertContract(required, pluginId, name);
    } catch (error) {
      throw new Error(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const definition = registry.get(pluginId);
    const switched =
      defaults.plugin !== undefined &&
      override.plugin !== undefined &&
      defaults.plugin !== override.plugin;
    const origins = new Map<string, string>();
    const fallbackDirectory =
      (switched ? options.override?.directory : options.defaults?.directory) ??
      options.override?.directory ??
      '.';
    const recordOrigins = (
      value: JsonValue,
      pointer: string,
      directory: string,
    ): void => {
      origins.set(pointer, directory);
      if (Array.isArray(value))
        value.forEach((entry, index) =>
          recordOrigins(entry, `${pointer}/${index}`, directory),
        );
      else if (isObject(value))
        for (const [key, entry] of Object.entries(value))
          recordOrigins(entry, `${pointer}/${pointerPart(key)}`, directory);
    };
    const merge = (
      base: JsonObject,
      extra: JsonObject,
      pointer: string,
      directory: string,
    ): JsonObject => {
      const result = structuredClone(base);
      for (const [key, value] of Object.entries(extra)) {
        const child = `${pointer}/${pointerPart(key)}`;
        if (isObject(value) && isObject(result[key]))
          result[key] = merge(result[key], value, child, directory);
        else {
          result[key] = structuredClone(value);
          for (const known of origins.keys())
            if (known === child || known.startsWith(`${child}/`))
              origins.delete(known);
          recordOrigins(value, child, directory);
        }
      }
      return result;
    };
    let config = switched ? {} : object(defaults.config ?? {});
    recordOrigins(config, '', fallbackDirectory);
    config = merge(
      config,
      object(override.config ?? {}),
      '',
      options.override?.directory ?? fallbackDirectory,
    );
    validate(definition.configSchema, config, `${label}.config`);
    config = resolvePaths(config, definition.configSchema, (pointer) => {
      let current = pointer;
      while (!origins.has(current) && current.includes('/'))
        current = current.slice(0, current.lastIndexOf('/'));
      return origins.get(current) ?? fallbackDirectory;
    });
    return new Binding(name, definition, config);
  }

  /** The caller supplies a full configuration with already prepared resource paths. */
  withConfig(config: JsonObject): Binding {
    const owned = structuredClone(
      object(config, `Binding ${this.name}.config`),
    );
    validate(
      this.definition.configSchema,
      owned,
      `Binding ${this.name}.config`,
    );
    return new Binding(this.name, this.definition, owned);
  }

  toJSON(): BindingData {
    return { plugin: this.pluginId, config: structuredClone(this.config) };
  }
}
