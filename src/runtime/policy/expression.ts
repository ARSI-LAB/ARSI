import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { json } from '../../shared/json.js';
import { dataFunctionArity, evaluateDataFunction } from './functions.js';
class ProtocolError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
  }
}
function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export type ExpressionAst =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'path'; parts: string[] }
  | { kind: 'access'; object: ExpressionAst; key: ExpressionAst }
  | { kind: 'call'; name: string; args: ExpressionAst[] }
  | { kind: 'unary'; operator: string; operand: ExpressionAst }
  | {
      kind: 'binary';
      operator: string;
      left: ExpressionAst;
      right: ExpressionAst;
    };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const roots = new Set([
  'config',
  'input',
  'state',
  'application',
  'init',
  'loop',
  'finish',
]);
const precedence: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '===': 3,
  '!==': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};
interface Token {
  value: string;
  kind: 'number' | 'string' | 'word' | 'operator';
}

const compiledExpressions = new Map<string, ExpressionAst>();

export function compileExpression(
  source: string,
  additionalRoots: readonly string[] = [],
): ExpressionAst {
  const cacheKey = `${source}\n${[...additionalRoots].sort().join(',')}`;
  const cached = compiledExpressions.get(cacheKey);
  if (cached) return cached;
  if (source.length > 4096)
    throw new ProtocolError('expression', 'exceeds 4096 characters');
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const rest = source.slice(position);
    const space = /^\s+/.exec(rest);
    if (space) {
      position += space[0].length;
      continue;
    }
    const number = /^(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      tokens.push({ value: number[0], kind: 'number' });
      position += number[0].length;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0];
      let end = 1;
      let value = '';
      let closed = false;
      for (; end < rest.length; end++) {
        const char = rest[end]!;
        if (char === quote) {
          closed = true;
          end++;
          break;
        }
        if (char === '\\') {
          end++;
          const escaped = rest[end];
          if (
            escaped === undefined ||
            !['\\', "'", '"', 'n', 'r', 't'].includes(escaped)
          )
            throw new ProtocolError('expression', 'unsupported string escape');
          value +=
            escaped === 'n'
              ? '\n'
              : escaped === 'r'
                ? '\r'
                : escaped === 't'
                  ? '\t'
                  : escaped;
        } else value += char;
      }
      if (!closed) throw new ProtocolError('expression', 'unterminated string');
      tokens.push({ kind: 'string', value });
      position += end;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      tokens.push({ kind: 'word', value: word[0] });
      position += word[0].length;
      continue;
    }
    const operator =
      /^(===|!==|==|!=|<=|>=|&&|\|\||[\[\]?:.,+\-*/%<>()!])/.exec(rest);
    if (operator) {
      tokens.push({ kind: 'operator', value: operator[0] });
      position += operator[0].length;
      continue;
    }
    throw new ProtocolError(
      'expression',
      `unsupported syntax near ${rest.slice(0, 24)}`,
    );
  }
  if (tokens.length > 512)
    throw new ProtocolError('expression', 'too many tokens');
  let index = 0;
  const parse = (minimum: number): ExpressionAst => {
    const token = tokens[index++];
    if (!token) throw new ProtocolError('expression', 'missing operand');
    let left: ExpressionAst;
    if (token.value === '!' || token.value === '-')
      left = { kind: 'unary', operator: token.value, operand: parse(7) };
    else if (token.value === '(') {
      left = parse(0);
      if (tokens[index++]?.value !== ')')
        throw new ProtocolError('expression', 'missing closing parenthesis');
    } else if (token.kind === 'number') {
      if (!Number.isFinite(Number(token.value)))
        throw new ProtocolError('expression', 'number literal must be finite');
      left = { kind: 'literal', value: Number(token.value) };
    } else if (token.kind === 'string')
      left = { kind: 'literal', value: token.value };
    else if (['true', 'false', 'null'].includes(token.value))
      left = {
        kind: 'literal',
        value: token.value === 'null' ? null : token.value === 'true',
      };
    else if (token.kind === 'word') {
      if (
        tokens[index]?.value === '(' &&
        Object.hasOwn(dataFunctionArity, token.value)
      ) {
        index++;
        const args: ExpressionAst[] = [];
        if (tokens[index]?.value !== ')') {
          while (true) {
            args.push(parse(0));
            if (tokens[index]?.value !== ',') break;
            index++;
          }
        }
        if (
          tokens[index++]?.value !== ')' ||
          args.length !== dataFunctionArity[token.value]
        )
          throw new ProtocolError(
            'expression',
            `invalid arguments for ${token.value}`,
          );
        left = { kind: 'call', name: token.value, args };
      } else {
        if (
          forbidden.has(token.value) ||
          (!roots.has(token.value) && !additionalRoots.includes(token.value))
        )
          throw new ProtocolError('expression', `unknown root ${token.value}`);
        const parts = [token.value];
        while (tokens[index]?.value === '.') {
          index++;
          const part = tokens[index++];
          if (!part || part.kind !== 'word' || forbidden.has(part.value))
            throw new ProtocolError('expression', 'invalid property access');
          parts.push(part.value);
        }
        left = { kind: 'path', parts };
      }
    } else throw new ProtocolError('expression', `unexpected ${token.value}`);
    while (tokens[index]?.value === '[' || tokens[index]?.value === '.') {
      const operator = tokens[index++]!.value;
      let key: ExpressionAst;
      if (operator === '.') {
        const property = tokens[index++];
        if (
          !property ||
          property.kind !== 'word' ||
          forbidden.has(property.value)
        )
          throw new ProtocolError('expression', 'invalid property access');
        key = { kind: 'literal', value: property.value };
      } else {
        key = parse(0);
        if (tokens[index++]?.value !== ']')
          throw new ProtocolError('expression', 'missing closing array index');
      }
      if (
        left.kind === 'path' &&
        key.kind === 'literal' &&
        (typeof key.value === 'string' ||
          (typeof key.value === 'number' &&
            Number.isSafeInteger(key.value) &&
            key.value >= 0))
      ) {
        if (forbidden.has(String(key.value)))
          throw new ProtocolError('expression', 'invalid property access');
        left = { kind: 'path', parts: [...left.parts, String(key.value)] };
      } else left = { kind: 'access', object: left, key };
    }
    while (index < tokens.length) {
      const operator = tokens[index]!.value;
      const rank = precedence[operator];
      if (rank === undefined || rank < minimum) break;
      index++;
      left = { kind: 'binary', operator, left, right: parse(rank + 1) };
    }
    if (minimum === 0 && tokens[index]?.value === '?') {
      index++;
      const yes = parse(0);
      if (tokens[index++]?.value !== ':')
        throw new ProtocolError('expression', 'missing conditional colon');
      left = { kind: 'call', name: 'if', args: [left, yes, parse(0)] };
    }
    return left;
  };
  const ast = parse(0);
  if (index !== tokens.length)
    throw new ProtocolError('expression', `unexpected ${tokens[index]!.value}`);
  if (compiledExpressions.size >= 2048) compiledExpressions.clear();
  compiledExpressions.set(cacheKey, ast);
  return ast;
}
function pathValue(
  parts: readonly string[],
  environment: JsonObject,
): JsonValue {
  if (parts.some((part) => forbidden.has(part)))
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
          !forbidden.has(key))
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
  const result = visit(compileExpression(source, Object.keys(environment)));
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
export function expressions(value: JsonValue): string[] {
  if (typeof value === 'string') {
    const match = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
    if (match) return [match[1]!.trim()];
    if (value.includes('${{'))
      throw new Error('Expression must occupy complete scalar');
    return [];
  }
  if (Array.isArray(value)) return value.flatMap(expressions);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(expressions);
  return [];
}
export function expressionPaths(ast: ExpressionAst): string[][] {
  if (ast.kind === 'path') return [ast.parts];
  if (ast.kind === 'access')
    return [...expressionPaths(ast.object), ...expressionPaths(ast.key)];
  if (ast.kind === 'call') return ast.args.flatMap(expressionPaths);
  if (ast.kind === 'unary') return expressionPaths(ast.operand);
  if (ast.kind === 'binary')
    return [...expressionPaths(ast.left), ...expressionPaths(ast.right)];
  return [];
}
