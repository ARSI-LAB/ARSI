import type { AgentEditingConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { json, string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { buildComparisonContext } from './comparison.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
>['create'] = async (config, _context) => {
  return {
    async execute(input, context) {
      json(input);
      const comparison =
        input.comparison === undefined
          ? undefined
          : await buildComparisonContext(input, context);
      const updated = await editResource(
        config,
        input,
        input.memoryRef === null ? null : string(input.memoryRef),
        context,
        comparison,
      );
      if (updated.changeRef !== null)
        return {
          status: 'updated',
          memoryRef: string(updated.resourceRef),
          changeRef: updated.changeRef,
          reason: updated.reason,
        };
      return {
        status: 'no-change',
        memoryRef: updated.resourceRef,
        changeRef: null,
        reason: updated.reason,
      };
    },
    async dispose() {},
  };
};
