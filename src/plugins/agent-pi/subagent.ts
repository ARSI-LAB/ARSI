import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  AgentInput,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, strings } from '../../shared/json.js';
import { validate, validateSchemaDefinition } from '../../shared/schema.js';

/** Await one independent session through Manager so receipts and budgets stay shared. */
export function createSubagentTool(
  parent: AgentInput,
  context: RuntimeContext,
): ToolDefinition {
  const parameters = {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1 },
      prompt: { type: 'string', minLength: 1 },
      input: {},
      filePaths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Names from your virtual files to share. Omit to share all; [] shares none.',
      },
      files: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Virtual text files you supply, added to or replacing the shared files.',
      },
      outputSchema: {
        type: 'object',
        description:
          'Optional JSON output schema; defaults to any JSON object.',
      },
    },
    required: ['goal', 'prompt'],
    additionalProperties: false,
  };
  return {
    name: 'run_subagent',
    label: 'Run subagent',
    description:
      'Delegate a task to an independent agent session and wait for its JSON result. ' +
      'Choose its goal, instructions, arbitrary JSON input and virtual files yourself. ' +
      "It can delegate further using the same tool and shares this call's Runtime budget and cancellation. " +
      'There is no separate delegation depth or count limit. It receives no conversation history ' +
      'and cannot access host files. Results are proposals, not applied edits. ' +
      'Identical requests in this call reuse the recorded result; change the task input for a follow-up.',
    parameters,
    async execute(_id, value: unknown, toolSignal) {
      const signal = toolSignal
        ? AbortSignal.any([context.signal, toolSignal])
        : context.signal;
      signal.throwIfAborted();
      validate(parameters, value, 'run_subagent input');
      const task = object(value);
      const available = parent.files ?? {};
      const selected =
        task.filePaths === undefined
          ? Object.keys(available)
          : strings(task.filePaths);
      const files: JsonObject = {};
      for (const path of selected) {
        if (!Object.hasOwn(available, path))
          throw new Error(
            `Subagent file is outside supplied snapshot: ${path}`,
          );
        files[path] = available[path]!;
      }
      Object.assign(files, object(task.files ?? {}));
      const outputSchema = object(task.outputSchema ?? { type: 'object' });
      validateSchemaDefinition(outputSchema, 'Subagent outputSchema');
      const result = await context.extend({ signal }).invokeAgent({
        agentRef: context.bindingId,
        goal: task.goal!,
        prompt: task.prompt!,
        input: task.input ?? null,
        files,
        outputSchema,
        ...(parent.maxModelCalls === undefined
          ? {}
          : { maxModelCalls: parent.maxModelCalls }),
      });
      signal.throwIfAborted();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
