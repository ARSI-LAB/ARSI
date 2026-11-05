import type {
  JsonObject,
  JsonValue,
  OperationDefinition,
} from '../../contracts/index.js';
import type {
  GridProposerInput,
  GridProposerOutput,
} from '../../contracts/plugin-types/proposer-grid.js';
import { json } from '../../shared/json.js';
import { commitParameters } from '../shared/parameter-editing/index.js';
import { validate } from '../../shared/schema.js';
import { safePath } from '../shared/file-application/target.js';
import { configSchema, type GridProposerConfig } from './schema.js';

type Axis = { name: string; size: number; values: JsonValue[] };

function axes(space: GridProposerConfig['searchSpace']): {
  values: Axis[];
  total: number;
} {
  let total = 1;
  const names = new Set<string>();
  const values = space.map((entry): Axis => {
    const { name } = entry;
    if (
      names.has(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    )
      throw new Error(
        `searchSpace.${name}: duplicate or forbidden parameter name`,
      );
    names.add(name);
    total *= entry.values.length;
    if (!Number.isSafeInteger(total))
      throw new Error('searchSpace cardinality exceeds the safe integer range');
    return {
      name,
      values: structuredClone(entry.values),
      size: entry.values.length,
    };
  });
  return { values, total };
}

export const createGridProposer: OperationDefinition<
  GridProposerInput,
  GridProposerOutput,
  GridProposerConfig
>['create'] = async (config) => {
  json(config);
  validate(configSchema, config, 'grid proposer config');
  const path = safePath(config.path);
  if (path.includes(':'))
    throw new Error('path must not contain a drive or alternate data stream');
  const grid = axes(config.searchSpace);
  return {
    async execute(input, context): Promise<GridProposerOutput> {
      context.signal.throwIfAborted();
      if (
        !Number.isSafeInteger(input.cursor) ||
        input.cursor < 0 ||
        input.cursor > grid.total
      )
        throw new Error(
          `cursor must be an integer between 0 and ${grid.total}`,
        );
      if (input.cursor === grid.total)
        return {
          status: 'exhausted',
          nextCursor: input.cursor,
          totalCandidates: grid.total,
        };
      let remaining = input.cursor;
      const parameters: JsonObject = {};
      for (const axis of [...grid.values].reverse()) {
        const index = remaining % axis.size;
        remaining = Math.floor(remaining / axis.size);
        parameters[axis.name] = structuredClone(axis.values[index]!);
      }
      return {
        status: 'candidate',
        candidateRef: await commitParameters(
          input.parent,
          path,
          parameters,
          context,
        ),
        parameters,
        nextCursor: input.cursor + 1,
        totalCandidates: grid.total,
      };
    },
    async dispose(): Promise<void> {},
  };
};
