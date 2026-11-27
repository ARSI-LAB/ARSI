import { fileURLToPath } from 'node:url';
import { runtimeEvolutionAgentConfigSchema } from '../shared/agent-editing/schema.js';

export type { RuntimeEvolutionAgentConfig } from '../shared/agent-editing/schema.js';
export const configSchema = runtimeEvolutionAgentConfigSchema(
  fileURLToPath(new URL('./prompt.md', import.meta.url)),
);
