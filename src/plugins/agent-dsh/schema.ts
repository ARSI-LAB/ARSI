import type { JsonSchema } from '../../contracts/index.js';
import { nativeOptionsSchema } from '../shared/native-agent/options.js';

export type AgentDshConfig = {
  executable?: string;
  options?: string[];
  timeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'dsh' },
    options: nativeOptionsSchema([
      '--profile',
      '--from-default-profile',
      '--patch',
      '--json',
      '--dump-config',
      '--dump-config-schema',
      '--dump-default-config',
    ]),
    timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
};
