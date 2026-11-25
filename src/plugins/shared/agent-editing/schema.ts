import type { JsonSchema } from '../../../contracts/index.js';

export type AgentEditingConfig = {
  prompt: string;
  agentRef?: string;
  guidance?: string;
  evidenceView?: 'execution' | 'training-summary';
  skills?: string[];
};

export type RuntimeEvolutionAgentConfig = Omit<
  AgentEditingConfig,
  'evidenceView'
>;

export const agentConfigSchema = {
  type: 'object',
  properties: {
    agentRef: {
      type: 'string',
      default: 'agent.default',
      'x-rsi-binding': 'contract.agent',
    },
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

/** The runtime evolution coordinator selects the evidence view before the editor runs. */
export function runtimeEvolutionAgentConfigSchema(prompt: string): JsonSchema {
  const { agentRef, guidance, skills } = agentConfigSchema.properties;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      agentRef,
      guidance,
      skills,
      prompt: { ...agentConfigSchema.properties.prompt, default: prompt },
    },
  };
}
