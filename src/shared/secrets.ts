import type { JsonValue } from '../contracts/json.js';

/** Environment credentials shared by evidence and read-only candidate projections. */
export function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /key|token|secret|password|authorization/i.test(key) &&
        typeof value === 'string' &&
        value.length >= 8,
    )
    .map(([, value]) => value!);
}
export function redactText(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text;
}

/** Remove known credentials from JSON string values while preserving its fields and structure. */
export function redactJsonSecrets(
  value: JsonValue,
  secrets: readonly string[],
): JsonValue {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactJsonSecrets(item, secrets));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactJsonSecrets(item, secrets),
      ]),
    );
  return value;
}
