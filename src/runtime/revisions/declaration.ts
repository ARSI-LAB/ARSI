import type { JsonSchema } from '../../contracts/index.js';
import { object, string, unknownKeys } from '../../shared/json.js';

export const reflectionInputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
};

export const reflectionResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    reflectionId: { type: 'string' },
    status: { enum: ['activated', 'no-change', 'skipped', 'rejected'] },
    reason: { type: 'string' },
    revisionRefs: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['reflectionId', 'status', 'reason', 'revisionRefs'],
  additionalProperties: false,
};

/** Both declaration sites select one complete file without merging its contents. */
export function reflectionConfigFile(value: unknown, label: string): string {
  const declaration = object(value, label);
  if (Object.hasOwn(declaration, 'ref'))
    throw new Error(`${label}.ref: migrate to ${label}.configFile`);
  unknownKeys(declaration, ['configFile'], label);
  const path = string(declaration.configFile, `${label}.configFile`);
  if (!path.trim()) throw new Error(`${label}.configFile: path is empty`);
  return path;
}
