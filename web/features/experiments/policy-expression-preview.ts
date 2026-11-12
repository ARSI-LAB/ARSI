import type { JsonObject, JsonValue } from '../../../src/contracts/json.js';
import type { StructureDetail } from '../../../src/contracts/policy-structure.js';

function savedConfigValue(
  configuration: JsonValue,
  path: readonly string[],
): JsonValue | undefined {
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration)
  )
    return undefined;
  const { configFields } = configuration;
  if (!Array.isArray(configFields)) return undefined;

  let match: JsonObject | undefined;
  for (const field of configFields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
    if (
      !Array.isArray(field.path) ||
      field.path.length !== path.length ||
      !field.path.every((part, index) => part === path[index])
    )
      continue;
    if (match) return undefined;
    match = field;
  }
  return match?.available === true ? match.savedValue : undefined;
}

export function resolvePolicyExpressionPreview(
  detail: StructureDetail,
  location: string,
  rootConfig?: JsonValue,
):
  | { kind: 'value'; value: JsonValue }
  | { kind: 'range'; label: string }
  | undefined {
  const matches = detail.expressionPreviews?.filter(
    (entry) => entry.location === location,
  );
  if (matches?.length !== 1) return undefined;
  const preview = matches[0]!;
  if (preview.kind === 'value') return preview;
  if (preview.kind === 'config') {
    if (rootConfig === null) return undefined;
    const value =
      rootConfig === undefined
        ? savedConfigValue(detail.configuration, preview.path)
        : preview.path.reduce<JsonValue | undefined>((current, part) => {
            if (
              current === undefined ||
              current === null ||
              typeof current !== 'object' ||
              !Object.hasOwn(current, part)
            )
              return undefined;
            return Array.isArray(current)
              ? current[Number(part)]
              : current[part];
          }, rootConfig);
    return value === undefined ? undefined : { kind: 'value', value };
  }

  const { start, end } = preview;
  const count = end - start;
  if (count === 0) return { kind: 'range', label: '0 items' };
  if (count === 1) return { kind: 'range', label: `${start} (1 item)` };
  return { kind: 'range', label: `${start}–${end - 1} (${count} items)` };
}
