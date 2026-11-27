import type { RuntimeEvolutionAgentConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { agentEditorDoctorRules } from '../shared/agent-editing/doctor.js';
import {
  evolutionContext,
  evolutionTaskVariables,
} from '../shared/agent-editing/evolution-context.js';
import { renderTaskMessage } from '../shared/agent-editing/task-message.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  RuntimeEvolutionAgentConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', (request) => agentEditorDoctorRules(request));
  return {
    async execute(input, context) {
      const evidence = await evolutionContext(
        'memory',
        input.evidenceRefs,
        context,
      );
      const updated = await editResource(
        config,
        input,
        input.resourceRef,
        context,
        await renderTaskMessage(
          context,
          config.messageTemplates,
          `Update experiment memory for the following objective:\n\n${input.goal}`,
          evolutionTaskVariables(input.goal, evidence),
        ),
        evidence,
      );
      if (updated.changeRef === null)
        return {
          status: 'no-change',
          resourceRef: input.resourceRef,
          changeRef: null,
          reason: updated.reason,
        };
      return {
        status: 'updated',
        resourceRef: string(updated.resourceRef),
        changeRef: updated.changeRef,
        reason: updated.reason,
      };
    },
    async dispose() {},
  };
};
