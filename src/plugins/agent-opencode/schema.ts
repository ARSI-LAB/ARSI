import type { JsonSchema } from '../../contracts/index.js';
import { nativeOptionsSchema } from '../shared/native-agent/options.js';

export type AgentOpenCodeConfig = {
  executable?: string;
  options?: string[];
  timeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'opencode' },
    options: nativeOptionsSchema([
      '--standalone',
      '--server',
      '--format',
      '--archived',
      '-v',
    ]),
    timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
