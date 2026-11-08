import {
  roleNamePattern,
  type AgentRole,
} from '../shared/agent-editing/project.js';
import type { JsonSchema } from '../../contracts/index.js';
import {
  agentConfigSchema,
  type AgentEditingConfig as SharedConfig,
} from '../shared/agent-editing/schema.js';

export type AgentEditingConfig = SharedConfig & {
  subagents?: AgentRole[];
};

export const configSchema: JsonSchema = {
  ...agentConfigSchema,
  properties: {
    ...agentConfigSchema.properties,
    subagents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: roleNamePattern },
          description: { type: 'string', minLength: 1 },
          prompt: { type: 'string', 'x-rsi-path': 'file' },
        },
        required: ['name', 'description', 'prompt'],
      },
    },
  },
};
