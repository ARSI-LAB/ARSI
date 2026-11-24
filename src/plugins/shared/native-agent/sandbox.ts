import type { JsonSchema } from '../../../contracts/index.js';

export type AgentSandboxMode = 'inherit' | 'read-only' | 'workspace-write';

// An omitted value stays absent in locked configurations and inherits at launch.
export const agentSandboxSchema: JsonSchema = {
  type: 'string',
  enum: ['inherit', 'read-only', 'workspace-write'],
};
