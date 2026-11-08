import type { JsonSchema } from '../../../contracts/index.js';

export type AgentEditingConfig = {
  prompt: string;
  agentRef?: string;
  guidance?: string;
  evidenceView?: 'execution' | 'training-summary';
  skills?: string[];
};

export const agentConfigSchema = {
  type: 'object',
  properties: {
    agentRef: { type: 'string', default: 'agent.default' },
    prompt: { type: 'string', 'x-rsi-path': 'file' },
    guidance: { type: 'string', 'x-rsi-path': 'directory' },
    evidenceView: {
      enum: ['execution', 'training-summary'],
      default: 'execution',
    },
    skills: {
      type: 'array',
      items: { type: 'string', 'x-rsi-path': 'directory' },
      default: [],
    },
  },
  required: ['prompt'],
  additionalProperties: false,
} satisfies JsonSchema;
