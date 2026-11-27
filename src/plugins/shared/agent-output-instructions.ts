import type { JsonObject } from '../../contracts/index.js';
import { canonical } from '../../shared/json.js';

export function outputInstructions(schema: JsonObject): string {
  return (
    'Return only a JSON object conforming to this JSON Schema as your final response, without a result envelope or prose.\n\n' +
    canonical(schema)
  );
}
