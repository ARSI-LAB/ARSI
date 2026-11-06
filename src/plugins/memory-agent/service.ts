import type { AgentEditingConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { json, string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { buildComparisonContext } from './comparison.js';
import { errorText } from '../../shared/errors.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
>['create'] = async (config, _context) => {
  return {
    async canRetry(_input, receipt, context) {
      if (
        receipt.status !== 'failed' ||
        receipt.experimentId !== context.experimentId ||
        typeof receipt.callId !== 'string' ||
        !receipt.callId
      )
        return false;
      // Evidence preparation is read-only. Editing and artifact capture occur only
      // after invokeAgent, whose child receipt is persisted before model execution.
      return !(await context.facts.list('calls')).some(
        (call) => call.parentCallId === receipt.callId,
      );
    },
    async execute(input, context) {
      json(input);
      try {
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
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof Error && error.name === 'ExperimentBudgetExceeded')
        )
          throw error;
        return {
          status: 'failed',
          memoryRef: input.memoryRef,
          changeRef: null,
          reason: errorText(error),
        };
      }
    },
    async dispose() {},
  };
};
