import type { JsonSchema } from '../../contracts/index.js';
import { nativeOptionsSchema } from '../shared/native-agent/options.js';

export type AgentCodexConfig = {
  executable?: string;
  options?: string[];
  timeoutMs?: number;
};

const overrideKeyPart = (key: string): string => `(?:${key}|"${key}"|'${key}')`;
const reservedOverrides = [
  'approval_policy',
  'project_root_markers',
  'sandbox_workspace_write',
  'sandbox_workspace_write.network_access',
  'features',
  'features.multi_agent',
  'agents',
  'agents.max_depth',
  'agents.[a-z0-9-]+.config_file',
].map((path) => path.split('.').map(overrideKeyPart).join('\\s*\\.\\s*'));

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'codex' },
    options: nativeOptionsSchema(
      ['--listen', '--stdio', '--print-startup-config', '--startup-sign-out'],
      [
        `(?:(?:-c=?|--config=)\\s*)?\\s*(?:${reservedOverrides.join('|')})\\s*=`,
        '(?:(?:--enable|--disable)=)?multi_agent$',
      ],
    ),
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
  },
};
