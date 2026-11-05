import { object, string, unknownKeys } from '../../shared/json.js';

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
