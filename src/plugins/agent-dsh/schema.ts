import type { JsonSchema } from '../../contracts/index.js';
import {
  agentSandboxSchema,
  type AgentSandboxMode,
} from '../shared/native-agent/sandbox.js';

export type AgentDshConfig = {
  executable?: string;
  sandbox?: AgentSandboxMode;
  timeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sandbox: agentSandboxSchema,
    executable: { type: 'string', minLength: 1, default: 'dsh' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
