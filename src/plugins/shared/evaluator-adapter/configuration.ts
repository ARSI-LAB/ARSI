import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { plain } from './data.js';
export function solverSelection(value: JsonValue | undefined): JsonObject {
  if (typeof value === 'string') return { name: value, config: {} };
  return plain(value);
}
