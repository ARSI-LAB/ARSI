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
  const shortFlags = flags
    .filter((flag) => /^-[A-Za-z]$/.test(flag))
    .map((flag) => flag[1])
    .join('');
  const reserved = [
    `(?:${flags.join('|')})(?:=|$)`,
    `-[${shortFlags}]`,
    ...reservedPatterns,
  ].join('|');
  return {
    type: 'array',
    description:
      'Extra CLI arguments in argv order. RSI reserves its protocol arguments.',
    items: { type: 'string', pattern: `^(?!${reserved})[^\\u0000]*$` },
  };
}
