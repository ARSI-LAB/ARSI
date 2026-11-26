import type { JsonObject } from '../../../contracts/index.js';

export function nativeOptionsSchema(
  reservedFlags: readonly string[],
  reservedPatterns: readonly string[] = [],
): JsonObject {
  const shortFlags = reservedFlags
    .filter((flag) => /^-[A-Za-z]$/.test(flag))
    .map((flag) => flag[1])
    .join('');
  const reserved: string[] = [];
  if (reservedFlags.length)
    reserved.push(`(?:${reservedFlags.join('|')})(?:=|$)`);
  if (shortFlags) reserved.push(`-[${shortFlags}]`);
  reserved.push(...reservedPatterns);
  const guard = reserved.length ? `(?!${reserved.join('|')})` : '';
  return {
    type: 'array',
    description:
      'Extra CLI arguments in argv order. RSI reserves its protocol arguments.',
    items: { type: 'string', pattern: `^${guard}[^\\u0000]*$` },
  };
}
