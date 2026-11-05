import type { JsonValue, JsonObject } from '../../contracts/index.js';
class ProtocolError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
  }
}
function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export const dataFunctionArity: Readonly<Record<string, number>> =
  Object.freeze({
    get: 3,
    length: 1,
    size: 1,
    flatten: 1,
    append: 2,
    concat: 2,
    pluck: 2,
    range: 2,
    some: 3,
    if: 3,
    compact: 1,
  });

function array(value: JsonValue): JsonValue[] {
  if (!Array.isArray(value))
    throw new ProtocolError('expression', 'data function requires an array');
  return value;
}
function property(
  value: JsonValue,
  key: JsonValue,
  fallback: JsonValue,
): JsonValue {
  if (Array.isArray(value)) {
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0)
      throw new ProtocolError(
        'expression.get',
        'array index must be a nonnegative integer',
      );
    return key < value.length ? value[key]! : fallback;
  }
  if (
    !isPlainObject(value) ||
    typeof key !== 'string' ||
    ['__proto__', 'prototype', 'constructor'].includes(key)
  )
    throw new ProtocolError(
      'expression.get',
      'requires an object and safe string key',
    );
  return Object.hasOwn(value, key) ? value[key]! : fallback;
}

/** Closed, side-effect-free data operations; never calls values supplied by a Policy. */
export function evaluateDataFunction(
  name: string,
  args: readonly JsonValue[],
): JsonValue {
  const [first, second, third] = args;
  switch (name) {
    case 'get':
      return property(first!, second!, third!);
    case 'length':
    case 'size':
      return array(first!).length;
    case 'flatten':
      return array(first!).flatMap((item) => array(item));
    case 'compact':
      return array(first!).filter((value) => value !== null);
    case 'append':
      return [...array(first!), second!];
    case 'concat':
      return [...array(first!), ...array(second!)];
    case 'pluck':
      return array(first!).map((value) => property(value, second!, null));
    case 'some':
      return array(first!).some(
        (value) => property(value, second!, null) === third,
      );
    case 'range': {
      if (
        typeof first !== 'number' ||
        typeof second !== 'number' ||
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(second) ||
        second < first
      )
        throw new ProtocolError(
          'expression.range',
          'requires ordered safe integer bounds',
        );
      return Array.from(
        { length: second - first },
        (_, offset) => first + offset,
      );
    }
    default:
      throw new ProtocolError('expression', `unsupported function ${name}`);
  }
}
