export function redactEnvironment(message: string): string {
  const secrets = Object.entries(process.env)
    .filter(
      ([name, secret]) =>
        secret &&
        /(?:key|token|password|secret|credential|authorization)s?(?:_|$)/i.test(
          name,
        ),
    )
    .map(([, secret]) => secret!)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets)
    message = message.replaceAll(secret, '[REDACTED]');
  return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

export function formatLogError(error: unknown): string {
  const visiting = new Set<Error>();
  const describe = (value: unknown, enclosing: readonly string[]): string => {
    const message = value instanceof Error ? value.message : String(value);
    const duplicate =
      message && enclosing.some((text) => text.includes(message));
    if (!(value instanceof Error)) return duplicate ? '' : message;
    if (visiting.has(value)) return '[circular error]';
    visiting.add(value);
    const known = message ? [...enclosing, message] : enclosing;
    const parts = duplicate ? [] : [message];
    if (value instanceof AggregateError)
      for (const nested of value.errors) parts.push(describe(nested, known));
    if (value instanceof SuppressedError)
      parts.push(
        describe(value.suppressed, known),
        describe(value.error, known),
      );
    if (value.cause !== undefined) {
      const cause = describe(value.cause, known);
      if (cause) parts.push(parts.some(Boolean) ? `cause: ${cause}` : cause);
    }
    visiting.delete(value);
    return parts.filter(Boolean).join('; ') || (duplicate ? '' : value.name);
  };
  return redactEnvironment(describe(error, []));
}

export function formatErrorStack(error: unknown): string {
  const visiting = new Set<Error>();
  const describe = (value: unknown): string => {
    if (!(value instanceof Error)) return String(value);
    if (visiting.has(value)) return '[circular error]';
    visiting.add(value);
    const lines = [value.stack || value.toString()];
    if (value instanceof AggregateError)
      for (const nested of value.errors)
        lines.push('Caused by: ' + describe(nested));
    if (value instanceof SuppressedError)
      lines.push(
        'Suppressed: ' + describe(value.suppressed),
        'Caused by: ' + describe(value.error),
      );
    if (value.cause !== undefined)
      lines.push('Caused by: ' + describe(value.cause));
    visiting.delete(value);
    return lines.join('\n');
  };
  return redactEnvironment(describe(error));
}
