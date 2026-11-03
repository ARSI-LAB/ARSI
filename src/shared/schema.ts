import Ajv from 'ajv';
import { digest } from './json.js';
import type { JsonObject, JsonSchema } from '../contracts/index.js';
const ajv = new Ajv.default({
  allErrors: true,
  strict: false,
  useDefaults: true,
});
export function validateSchemaDefinition(
  schema: JsonSchema,
  label: string,
): void {
  if (!ajv.validateSchema(schema))
    throw new Error(`${label}: invalid JSON Schema: ${ajv.errorsText()}`);
}
export function validate(
  schema: JsonSchema,
  value: unknown,
  label = 'value',
): void {
  const existing =
    typeof schema === 'object' && typeof schema.$id === 'string'
      ? ajv.getSchema(schema.$id)
      : undefined;
  if (existing && digest(existing.schema) !== digest(schema))
    throw new Error(
      `Conflicting Schema identity: ${typeof schema === 'object' ? schema.$id : ''}`,
    );
  const check = existing ?? ajv.compile(schema);
  if (!check(value))
    throw new Error(`${label}: ${ajv.errorsText(check.errors)}`);
}

/** The caller owns the Schema/type pairing; validation fills defaults on an owned copy. */
export function parseConfig<C extends JsonObject>(
  schema: JsonSchema,
  value: unknown,
  label = 'plugin config',
): C {
  const config: unknown = structuredClone(value);
  validate(schema, config, label);
  return config as C;
}
