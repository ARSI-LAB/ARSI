import type {
  OperationDefinition,
  ReflectionInput,
  ReflectionOutput,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { reflectionContract } from '../../contracts/plugin-types/index.js';
import { createReflectionAgent } from './service.js';
import { checkAgentEditor } from '../../runtime/doctor/business-checks.js';
export const reflectionDefinition: OperationDefinition<
  ReflectionInput,
  ReflectionOutput,
  AgentEditingConfig
> = {
  id: 'reflection.agent',
  description: 'Propose revisions to optimization guidance.',
  contract: reflectionContract,
  configSchema,
  create: createReflectionAgent,
  doctor: checkAgentEditor,
};
