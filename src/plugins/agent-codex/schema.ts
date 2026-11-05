import type { JsonSchema } from '../../contracts/index.js';

export type AgentCodexConfig = {
  executable?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  timeoutMs?: number;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};
export type ResolvedAgentCodexConfig = Required<
  Omit<AgentCodexConfig, 'timeoutMs'>
> &
  Pick<AgentCodexConfig, 'timeoutMs'>;

export const configSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'string', minLength: 1, default: 'codex' },
    model: { type: 'string', minLength: 1, default: '${MODEL_NAME}' },
    base_url: { type: 'string', minLength: 1, default: '${MODEL_ENDPOINT}' },
    api_key: {
      type: 'string',
      pattern: '^\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}$',
      default: '${MODEL_API_KEY}',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    },
    thinkingLevel: {
      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      default: 'off',
    },
  },
};

/** Credentials are resolved only at execution, never in saved Recipe bindings. */
export function resolveCodexConfig(
  config: ResolvedAgentCodexConfig,
): ResolvedAgentCodexConfig {
  const resolved = { ...config };
  for (const field of ['model', 'base_url', 'api_key'] as const) {
    resolved[field] = config[field].replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        const value = process.env[name];
        if (!value)
          throw new Error(
            `agent.codex ${field} references missing environment variable ${name}`,
          );
        return value;
      },
    );
    if (!resolved[field].trim())
      throw new Error(`agent.codex ${field} resolved to an empty value`);
  }
  const url = new URL(resolved.base_url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'agent.codex base_url must be an HTTP(S) API base URL without credentials, query or fragment',
    );
  return resolved;
}
