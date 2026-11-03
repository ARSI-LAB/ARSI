import type { JsonSchema } from './json.js';
import { object, string, unknownKeys } from '../shared/json.js';
import { validateSchemaDefinition } from '../shared/schema.js';

/** A public abstract plugin type, independent of implementation and configuration. */
export interface PluginContract {
  readonly id: string;
  readonly input_schema: JsonSchema;
  readonly output_schema: JsonSchema;
}

/** Check and copy declarations so callers cannot add implementation-specific IO fields. */
export function defineContract(value: unknown): PluginContract {
  const source = object(value, 'plugin contract');
  unknownKeys(
    source,
    ['id', 'input_schema', 'output_schema'],
    'plugin contract',
  );
  const id = string(source.id, 'plugin contract.id');
  const schema = (value: unknown, label: string): JsonSchema => {
    const result = typeof value === 'boolean' ? value : object(value, label);
    validateSchemaDefinition(result, label);
    return structuredClone(result);
  };
  const freeze = <T>(value: T): T => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze({
    id,
    input_schema: schema(source.input_schema, `${id}.input_schema`),
    output_schema: schema(source.output_schema, `${id}.output_schema`),
  });
}
