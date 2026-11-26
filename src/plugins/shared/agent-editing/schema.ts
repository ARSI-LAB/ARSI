import type { JsonSchema } from '../../../contracts/index.js';
import {
  runtimeEvolutionEvidenceViews,
  type RuntimeEvolutionEvidenceView,
} from '../../../contracts/runtime-evolution.js';

export type AgentEditingConfig = {
  prompt: string;
  agentRef?: string;
  evidenceView?: RuntimeEvolutionEvidenceView;
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
    evidenceView: {
      enum: [...runtimeEvolutionEvidenceViews],
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
  const { agentRef, skills } = agentConfigSchema.properties;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      agentRef,
      skills,
      prompt: { ...agentConfigSchema.properties.prompt, default: prompt },
    },
  };
}
