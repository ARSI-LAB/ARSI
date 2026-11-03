import type { JsonObject, JsonValue } from '../../../contracts/index.js';
import { json, object } from '../../../shared/json.js';
export function clone(value: unknown): JsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  json(parsed);
  return parsed;
}
export function plain(value: JsonValue | undefined): JsonObject {
  return value === undefined ? {} : object(value);
}
export function nullableObject(
  value: JsonValue | undefined,
): JsonObject | null {
  return value === null || value === undefined ? null : object(value);
}
export function redact(value: unknown): JsonValue {
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => v && /(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(k))
    .map(([, v]) => v!)
    .sort((a, b) => b.length - a.length);
  const scrub = (entry: JsonValue): JsonValue => {
    if (typeof entry === 'string') {
      let text = entry;
      for (const secret of secrets)
        text = text.replaceAll(secret, '[REDACTED]');
      return text;
    }
    if (Array.isArray(entry)) return entry.map(scrub);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [key, scrub(child)]),
      );
    return entry;
  };
  return scrub(clone(value ?? null));
}
