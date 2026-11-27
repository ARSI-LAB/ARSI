import { fileURLToPath } from 'node:url';
import type { RuntimeEvolutionAgentConfig } from './schema.js';
import type {
  OperationDefinition,
  ReflectionInput,
  ReflectionOutput,
} from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import {
  evolutionContext,
  evolutionTaskVariables,
} from '../shared/agent-editing/evolution-context.js';
import { renderTaskMessage } from '../shared/agent-editing/task-message.js';
import { checkReflectionAgent } from './doctor.js';

export const reflectionReviewer = {
  name: 'reflection-reviewer',
  description:
    'Review a focused Reflection question against the authorized workspace evidence.',
  prompt: fileURLToPath(new URL('./reviewer.md', import.meta.url)),
};

export const createReflectionAgent: OperationDefinition<
  ReflectionInput,
  ReflectionOutput,
  RuntimeEvolutionAgentConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', checkReflectionAgent);
  return {
    async execute(input, context) {
      const evidence = await evolutionContext(
        'reflection',
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
          `Propose revisions to the authorized resources for the following objective:\n\n${input.goal}`,
          evolutionTaskVariables(input.goal, evidence),
        ),
        evidence,
        [reflectionReviewer],
      );
      if (updated.changeRef !== null)
        return {
          status: 'proposed',
          proposal: {
            parentRevisionRefs: input.parentRevisionRefs,
            resourceRef: string(updated.resourceRef),
            changeRef: updated.changeRef,
          },
          reason: updated.reason,
        };
      return {
        status: 'no-change',
        proposal: null,
        reason: updated.reason,
      };
    },
    async dispose() {},
  };
};
