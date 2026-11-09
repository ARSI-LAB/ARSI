import type { JsonSchema } from '../../contracts/index.js';

export type AgentKernelConfig = {
  // Python bridge implementing the kernel-agent JSON stdin/stdout protocol.
  script: string;
  executable?: string;
  timeoutMs?: number;
  // Process-env variable names forwarded to the bridge at execute time.
  // Values are never persisted; the bridge reads model credentials from them.
  env?: string[];
};

export type ResolvedAgentKernelConfig = Required<AgentKernelConfig>;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    script: { type: 'string', minLength: 1, 'x-rsi-path': 'file' },
    executable: { type: 'string', minLength: 1, default: 'python3' },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 600000,
    },
    env: {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      default: [],
    },
  },
  required: ['script'],
  additionalProperties: false,
};
