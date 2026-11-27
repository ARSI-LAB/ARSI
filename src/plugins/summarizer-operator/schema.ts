import { recordSchema } from '../../contracts/models/measurement.js';
import {
  messageTemplatesSchema,
  type MessageTemplates,
} from '../shared/agent-editing/task-message.js';

const summaryTemplateStages = ['summarize', 'summarize-metrics'] as const;

export type OperatorSummarizerConfig = {
  agentRef: string;
  promptFile: string;
  modelRequestTimeoutMs?: number;
  messageTemplates?: MessageTemplates<(typeof summaryTemplateStages)[number]>;
};

export const configSchema = recordSchema(
  {
    agentRef: {
      type: 'string',
      minLength: 1,
      default: 'agent',
      'x-rsi-binding': 'contract.agent',
    },
    promptFile: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
    messageTemplates: messageTemplatesSchema(...summaryTemplateStages),
    modelRequestTimeoutMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
  },
  ['promptFile'],
);
