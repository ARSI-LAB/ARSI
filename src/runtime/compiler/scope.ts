import type { JsonObject, JsonValue } from '../../contracts/index.js';
import {
  compileExpression,
  expressionPaths,
  expressions,
} from '../policy/expression.js';

export const scopeRoots = [
  'application',
  'budget',
  'config',
  'input',
  'state',
  'init',
  'loop',
  'finish',
];
export const safeIdentifier = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface Scope {
  initialized: Set<string>;
  available: Record<string, Set<string>>;
  types: Record<string, JsonObject>;
  parallel: boolean;
  loopDepth: number;
}
export function cloneScope(scope: Scope): Scope {
  return {
    ...scope,
    initialized: new Set(scope.initialized),
    available: Object.fromEntries(
      Object.entries(scope.available).map(([k, v]) => [k, new Set(v)]),
    ),
    types: { ...scope.types },
  };
}

export function validateTemplate(
  value: JsonValue,
  scope: Scope,
  label: string,
  allowedRoots = Object.keys(scope.types),
): void {
  for (const expression of expressions(value)) {
    const ast = compileExpression(expression, allowedRoots);
    for (const path of expressionPaths(ast)) {
      if (!allowedRoots.includes(path[0]!))
        throw new Error(`${label}: root ${path[0]} is not allowed`);
      if (path[0] === 'state' && path[1] && !scope.initialized.has(path[1]))
        throw new Error(
          `${label}: state.${path[1]} is not initialized on every path`,
        );
      if (
        ['init', 'loop', 'finish'].includes(path[0]!) &&
        path[1] &&
        !['index', 'input'].includes(path[1]) &&
        !scope.available[path[0]!]!.has(path[1])
      )
        throw new Error(
          `${label}: unavailable output ${path.slice(0, 2).join('.')}`,
        );
    }
  }
}
