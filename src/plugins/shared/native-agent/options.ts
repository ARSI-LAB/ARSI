import type { JsonObject } from '../../../contracts/index.js';

export function nativeOptionsSchema(
  reservedFlags: readonly string[],
  reservedPatterns: readonly string[] = [],
): JsonObject {
  const flags = [
    '-',
    '--',
    '-h',
    '--help',
    '-V',
    '--version',
    ...reservedFlags,
  ];
  const reserved = [`(?:${flags.join('|')})(?:=|$)`, ...reservedPatterns].join(
    '|',
  );
  return {
    type: 'array',
    description:
      'Extra CLI arguments in argv order. RSI reserves its protocol arguments.',
    items: { type: 'string', pattern: `^(?!${reserved})[^\\u0000]*$` },
  };
}
