import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { json } from '../../shared/json.js';
import { evaluateDataFunction } from './functions.js';
import {
  compileExpression,
  isForbiddenExpressionProperty,
  ProtocolError,
  type ExpressionAst,
} from './expression-syntax.js';

export {
  compileExpression,
  expressionPaths,
  expressions,
  type ExpressionAst,
} from './expression-syntax.js';

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function pathValue(
  parts: readonly string[],
  environment: JsonObject,
): JsonValue {
  if (parts.some((part) => isForbiddenExpressionProperty(part)))
    throw new ProtocolError('expression', 'invalid path');
  let value: JsonValue = environment;
  for (const part of parts) {
    if (
      (!isPlainObject(value) && !Array.isArray(value)) ||
      !Object.hasOwn(value, part)
    )
      throw new ProtocolError('expression', `missing value ${parts.join('.')}`);
    value = Array.isArray(value)
      ? value[Number(part)]!
      : (value[part] as JsonValue);
  }
  return value;
}
export function evaluateExpression(
  source: string,
  environment: JsonObject,
): JsonValue {
  return evaluateExpressionAst(
    compileExpression(source, Object.keys(environment)),
    environment,
  );
}

export function evaluateExpressionAst(
  ast: ExpressionAst,
  environment: JsonObject,
): JsonValue {
  const numeric = (value: JsonValue): number => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new ProtocolError(
        'expression',
        'numeric operator requires finite numbers',
      );
    return value;
  };
  const boolean = (value: JsonValue): boolean => {
    if (typeof value !== 'boolean')
      throw new ProtocolError(
        'expression',
        'logical operator requires booleans',
      );
    return value;
  };
  const visit = (ast: ExpressionAst): JsonValue => {
    if (ast.kind === 'literal') return ast.value;
    if (ast.kind === 'path') return pathValue(ast.parts, environment);
    if (ast.kind === 'access') {
      const object = visit(ast.object);
      const key = visit(ast.key);
      if (
        (Array.isArray(object) &&
          typeof key === 'number' &&
          Number.isSafeInteger(key) &&
          key >= 0) ||
        (isPlainObject(object) &&
          typeof key === 'string' &&
          !isForbiddenExpressionProperty(key))
      ) {
        if (!Object.hasOwn(object, key))
          throw new ProtocolError(
            'expression',
            `missing value at index ${String(key)}`,
          );
        return Array.isArray(object)
          ? object[Number(key)]!
          : object[String(key)]!;
      }
      throw new ProtocolError('expression', 'invalid indexed access');
    }
    if (ast.kind === 'call') {
      if (ast.name === 'if')
        return visit(ast.args[boolean(visit(ast.args[0]!)) ? 1 : 2]!);
      return evaluateDataFunction(ast.name, ast.args.map(visit));
    }
    if (ast.kind === 'unary') {
      const value = visit(ast.operand);
      return ast.operator === '!' ? !boolean(value) : -numeric(value);
    }
    const left = visit(ast.left);
    if (ast.operator === '&&')
      return boolean(left) && boolean(visit(ast.right));
    if (ast.operator === '||')
      return boolean(left) || boolean(visit(ast.right));
    const right = visit(ast.right);
    switch (ast.operator) {
      case '==':
      case '===':
        return left === right;
      case '!=':
      case '!==':
        return left !== right;
      case '+':
        return numeric(numeric(left) + numeric(right));
      case '-':
        return numeric(numeric(left) - numeric(right));
      case '*':
        return numeric(numeric(left) * numeric(right));
      case '/':
        return numeric(numeric(left) / numeric(right));
      case '%':
        return numeric(numeric(left) % numeric(right));
      case '<':
        return numeric(left) < numeric(right);
      case '>':
        return numeric(left) > numeric(right);
      case '<=':
        return numeric(left) <= numeric(right);
      case '>=':
        return numeric(left) >= numeric(right);
      default:
        throw new ProtocolError('expression', `unsupported ${ast.operator}`);
    }
  };
  const result = visit(ast);
  json(result);
  return result;
}

export function evaluateTemplate(
  value: JsonValue,
  environment: JsonObject,
): JsonValue {
  if (typeof value === 'string') {
    const match = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
    if (match) return evaluateExpression(match[1]!.trim(), environment);
    if (value.includes('${{'))
      throw new Error('Expression must occupy the complete scalar');
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => evaluateTemplate(item, environment));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        evaluateTemplate(child, environment),
      ]),
    );
  return value;
}
