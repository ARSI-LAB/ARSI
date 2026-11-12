import { object, string, unknownKeys } from '../../shared/json.js';
import { validateTemplate } from '../compiler/scope.js';

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

/** A Policy may conditionally assemble Reflection from its configuration. */
export function reflectionDefaults(value: unknown): {
  configFile: string;
  enabled: boolean | string;
} {
  const label = 'policy.defaults.reflection';
  const { enabled = true, ...file } = object(value, label);
  const configFile = reflectionConfigFile(file, label);
  if (typeof enabled !== 'boolean' && typeof enabled !== 'string')
    throw new Error(`${label}.enabled: expected a boolean or expression`);
  validateTemplate(
    enabled,
    { names: ['config'], frames: [], parallel: false, loopDepth: 0 },
    `${label}.enabled`,
  );
  return { configFile, enabled };
}
