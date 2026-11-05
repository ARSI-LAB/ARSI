import type { JsonValue } from '../../contracts/index.js';
import {
  compileExpression,
  expressionPaths,
  expressions,
} from '../policy/expression.js';
export { safeIdentifier } from '../policy/steps.js';
export const scopeRoots = [
  'application',
  'budget',
  'config',
  'input',
  'state',
  'steps',
];
export interface Scope {
  readonly names: readonly string[];
  readonly frames: readonly {
    declared: ReadonlySet<string>;
    completed: ReadonlySet<string>;
  }[];
  readonly parallel: boolean;
  readonly loopDepth: number;
}
export function validateTemplate(
  value: JsonValue,
  scope: Scope,
  label: string,
  additional: readonly string[] = [],
): void {
  const roots = [...scope.names, ...additional];
  for (const expression of expressions(value)) {
    const ast = compileExpression(expression, roots);
    for (const path of expressionPaths(ast)) {
      if (!roots.includes(path[0]!))
        throw new Error(`${label}: root ${path[0]} is not allowed`);
      if (path[0] === 'steps') {
        if (path.length < 3 || path[2] !== 'output')
          throw new Error(
            `${label}: step reference must use steps.<id>.output`,
          );
        const name = path[1]!;
        const frame = [...scope.frames]
          .reverse()
          .find((entry) => entry.declared.has(name));
        if (!frame?.completed.has(name))
          throw new Error(`${label}: unavailable output steps.${name}`);
      }
    }
  }
}
