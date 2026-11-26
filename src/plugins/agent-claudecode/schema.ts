import type { JsonSchema } from '../../contracts/index.js';
import { nativeOptionsSchema } from '../shared/native-agent/options.js';

export type AgentClaudeCodeConfig = {
  executable?: string;
  options?: string[];
  timeoutMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'claude' },
    options: nativeOptionsSchema(
      [
        '-',
        '--',
        '-h',
        '--help',
        '-V',
        '--version',
        '-p',
        '--print',
        '--input-format',
        '--output-format',
        '--verbose',
        '--no-session-persistence',
        '--forward-subagent-text',
        '--json-schema',
        '-v',
      ],
      [
        // Claude can pack reserved switches after the boolean -c (--continue).
        '-c+[hpvV]',
      ],
    ),
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
