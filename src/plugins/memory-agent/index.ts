import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { memoryContract } from '../../contracts/plugin-types/index.js';
import { createMemoryAgent } from './service.js';
export const memoryDefinition: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
> = {
  id: 'memory.agent',
  description: 'Consolidate experiment experience into reusable memory.',
  contract: memoryContract,
  configSchema,
  create: createMemoryAgent,
};
