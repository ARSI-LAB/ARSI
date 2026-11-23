import type { LearningAgentConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { agentEditorDoctorRules } from '../shared/agent-editing/doctor.js';
import { learningContext } from '../shared/agent-editing/learning-context.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  LearningAgentConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', (request) => agentEditorDoctorRules(request));
  return {
    async execute(input, context) {
      const updated = await editResource(
        config,
        input,
        input.resourceRef,
        context,
        await learningContext('memory', input.evidenceRefs, context),
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
