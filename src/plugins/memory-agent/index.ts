import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type LearningAgentConfig } from './schema.js';
import { memoryContract } from '../../contracts/plugin-types/index.js';
import { createMemoryAgent } from './service.js';
export const memoryDefinition: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  LearningAgentConfig
> = {
  id: 'memory.agent',
  description: 'Consolidate experiment experience into reusable memory.',
  contract: memoryContract,
  configSchema,
  create: createMemoryAgent,
};
