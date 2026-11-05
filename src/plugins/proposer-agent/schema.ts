import type { JsonSchema } from '../../contracts/index.js';
import {
  agentConfigSchema,
  type AgentEditingConfig as SharedConfig,
} from '../shared/agent-editing/schema.js';

export type AgentEditingConfig = SharedConfig & {
  editProtocol?: 'replacement' | 'patch';
};

export const configSchema: JsonSchema = {
  ...agentConfigSchema,
  properties: {
    ...agentConfigSchema.properties,
    editProtocol: { enum: ['replacement', 'patch'], default: 'replacement' },
  },
};
