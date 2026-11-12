import { recordSchema } from '../../contracts/models/measurement.js';

export type OperatorSummarizerConfig = {
  agentRef: string;
  promptFile: string;
  modelRequestTimeoutMs?: number;
};

export const configSchema = recordSchema(
  {
    agentRef: { type: 'string', minLength: 1, default: 'agent' },
    promptFile: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
    modelRequestTimeoutMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
  },
  ['promptFile'],
);
