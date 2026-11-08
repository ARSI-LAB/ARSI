/** Error boundaries keep diagnostics without persisting configured credentials. */
export function errorText(error: unknown): string {
  const visiting = new Set<Error>();
  const describe = (value: unknown): string => {
    if (!(value instanceof Error)) return String(value);
    if (visiting.has(value)) return '[circular error]';
    visiting.add(value);
    const parts = [value.message];
    if (value instanceof AggregateError)
      for (const nested of value.errors) parts.push(describe(nested));
    if (value.cause !== undefined)
      parts.push(`cause: ${describe(value.cause)}`);
    visiting.delete(value);
    return parts.filter(Boolean).join('; ') || value.name;
  };
  let message = describe(error);
  for (const [key, value] of Object.entries(process.env))
    if (value && /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(key))
      message = message.replaceAll(value, '[REDACTED]');
  return message;
}

/** The candidate did not start. Expose this to the caller only after confirming cleanup. */
export class InferenceStartupError extends Error {
  override readonly name = 'InferenceStartupError';

  constructor(reason: string) {
    super(
      errorText(reason)
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, 1024) || 'Inference service did not become ready',
    );
  }
}
