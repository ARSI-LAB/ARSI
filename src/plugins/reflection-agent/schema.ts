import { fileURLToPath } from 'node:url';
import { learningAgentConfigSchema } from '../shared/agent-editing/schema.js';

export type { LearningAgentConfig } from '../shared/agent-editing/schema.js';
export const configSchema = learningAgentConfigSchema(
  fileURLToPath(new URL('./prompt.md', import.meta.url)),
);
