import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { digest, object } from '../../shared/json.js';
import {
  compileExpression,
  expressions,
  type ExpressionAst,
} from '../policy/expression.js';

export function mergeSchemas(
  a: JsonObject | undefined,
  b: JsonObject,
): JsonObject {
  if (!a) return b;
  if (digest(a) === digest(b)) return a;
  if (a.type === 'array' && b.type === 'array')
    return {
      type: 'array',
      ...(a.items || b.items
        ? {
            items: mergeSchemas(
              a.items ? object(a.items) : undefined,
              b.items ? object(b.items) : {},
            ),
          }
        : {}),
    };
  const choices: Array<JsonValue> = Array.isArray(a.anyOf) ? [...a.anyOf] : [a];
  if (!choices.some((c) => digest(c) === digest(b))) choices.push(b);
  return { anyOf: choices };
}
function pathSchema(
  parts: string[],
  types: Record<string, JsonObject>,
): JsonObject {
  let current = types[parts[0]!] ?? {};
  for (const key of parts.slice(1)) {
    if (current.type === 'array') {
      current =
        current.items && typeof current.items === 'object'
          ? object(current.items)
          : {};
      continue;
    }
    const props =
      current.properties && typeof current.properties === 'object'
        ? object(current.properties)
        : {};
    current =
      props[key] && typeof props[key] === 'object' ? object(props[key]) : {};
  }
  return current;
}
function inferAst(
  ast: ExpressionAst,
  types: Record<string, JsonObject>,
): JsonObject {
  if (ast.kind === 'literal') return inferSchema(ast.value, types);
  if (ast.kind === 'path') return pathSchema(ast.parts, types);
  if (ast.kind === 'access') {
    const parent = inferAst(ast.object, types);
    return parent.type === 'array' && parent.items ? object(parent.items) : {};
  }
  if (ast.kind === 'unary')
    return { type: ast.operator === '!' ? 'boolean' : 'number' };
  if (ast.kind === 'binary')
    return {
      type: ['+', '-', '*', '/', '%'].includes(ast.operator)
        ? 'number'
        : 'boolean',
    };
  if (['length', 'size'].includes(ast.name)) return { type: 'integer' };
  if (ast.name === 'some') return { type: 'boolean' };
  if (ast.name === 'if')
    return mergeSchemas(
      inferAst(ast.args[1]!, types),
      inferAst(ast.args[2]!, types),
    );
  if (ast.name === 'range')
    return { type: 'array', items: { type: 'integer' } };
  if (ast.name === 'append') {
    const a = inferAst(ast.args[0]!, types);
    return {
      type: 'array',
      items: mergeSchemas(
        a.items ? object(a.items) : undefined,
        inferAst(ast.args[1]!, types),
      ),
    };
  }
  if (['concat', 'compact', 'flatten', 'pluck'].includes(ast.name))
    return { type: 'array' };
  if (ast.name === 'get')
    return mergeSchemas({}, inferAst(ast.args[2]!, types));
  return {};
}
export function inferSchema(
  value: JsonValue,
  types: Record<string, JsonObject>,
  depth = 0,
): JsonObject {
  if (depth > 20) throw new Error('State type exceeds finite inference depth');
  if (typeof value === 'string') {
    const found = expressions(value);
    return found.length
      ? inferAst(compileExpression(found[0]!, Object.keys(types)), types)
      : { type: 'string' };
  }
  if (value === null) return { type: 'null' };
  if (typeof value === 'number')
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (Array.isArray(value))
    return {
      type: 'array',
      ...(value.length
        ? {
            items: value
              .map((v) => inferSchema(v, types, depth + 1))
              .reduce((a, b) => mergeSchemas(a, b)),
          }
        : {}),
    };
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        inferSchema(v, types, depth + 1),
      ]),
    ),
    required: Object.keys(value),
    additionalProperties: false,
  };
}
