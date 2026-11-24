import type { JsonSchema } from '../../contracts/index.js';
import {
  agentSandboxSchema,
  type AgentSandboxMode,
} from '../shared/native-agent/sandbox.js';

export type AgentCodexConfig = {
  executable?: string;
  model?: string;
  thinkingLevel?: string;
  timeoutMs?: number;
  sandbox?: AgentSandboxMode;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'codex' },
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    thinkingLevel: { type: 'string', minLength: 1, pattern: '\\S' },
    sandbox: agentSandboxSchema,
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
