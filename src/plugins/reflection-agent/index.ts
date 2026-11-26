import type {
  OperationDefinition,
  ReflectionInput,
  ReflectionOutput,
} from '../../contracts/index.js';
import { configSchema, type RuntimeEvolutionAgentConfig } from './schema.js';
import { reflectionContract } from '../../contracts/plugin-types/index.js';
import { createReflectionAgent } from './service.js';
export const reflectionDefinition: OperationDefinition<
  ReflectionInput,
  ReflectionOutput,
  RuntimeEvolutionAgentConfig
> = {
  id: 'reflection.agent',
  description:
    'Propose revisions to authorized plugin instructions, skills and role prompts.',
  contract: reflectionContract,
  configSchema,
  create: createReflectionAgent,
};
