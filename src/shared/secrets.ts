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
