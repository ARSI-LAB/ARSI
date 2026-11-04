import type { JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { runCodexProcess } from './process.js';

/** Read effective configuration through Codex, without parsing or copying its credentials. */
export async function readLocalConfig(
  executable: string,
  directory: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  let config: JsonObject | undefined;
  await runCodexProcess(
    executable,
    directory,
    ['app-server', ...executionOverrides({})],
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ember_rsi', version: '0.0.0' } },
    }) + '\n',
    signal,
    (line, send) => {
      const response = object(JSON.parse(line));
      if (response.id !== 1 && response.id !== 2) return;
      if (response.error)
        throw new Error('Cannot read local Codex configuration');
      if (response.id === 1) {
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'config/read',
          params: { includeLayers: false },
        });
      } else {
        config = object(object(response.result).config);
        // Closing stdin lets the app-server finish normally without starting a thread.
        return true;
      }
    },
  );
  if (!config) throw new Error('Codex returned no local configuration');
  return config;
}

export async function readCodexVersion(
  executable: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  let version = '';
  await runCodexProcess(
    executable,
    directory,
    ['--version'],
    '',
    signal,
    (line) => {
      if (!/^codex(?:-cli)?\s+\S+/.test(line) || line.length > 256)
        throw new Error('Cannot identify installed Codex version');
      version = line.trim();
      return true;
    },
  );
  if (!version) throw new Error('Codex returned no version');
  return version;
}

export type LocalProvider = {
  id: string;
  name: string;
  requiresOpenaiAuth: boolean;
  apiBaseUrl: string;
  chatgptBaseUrl: string;
};

export function localProvider(config: JsonObject): LocalProvider {
  const profile =
    typeof config.profile === 'string'
      ? object(object(config.profiles)[config.profile])
      : {};
  const id = string(
    profile.model_provider ?? config.model_provider ?? 'openai',
  );
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(
      'Local Codex provider id must contain only letters, digits, underscores or hyphens',
    );
  const providers = config.model_providers
    ? object(config.model_providers)
    : {};
  const provider = providers[id] ? object(providers[id]) : {};
  if (provider.wire_api && provider.wire_api !== 'responses')
    throw new Error(
      'agent.codex requires a Responses-compatible local Codex provider',
    );
  const base =
    provider.base_url ??
    (id === 'openai'
      ? (config.openai_base_url ??
        process.env.OPENAI_BASE_URL ??
        'https://api.openai.com/v1')
      : undefined);
  if (!base) throw new Error(`Local Codex provider ${id} has no base_url`);
  return {
    id,
    name: string(provider.name ?? (id === 'openai' ? 'OpenAI' : id)),
    requiresOpenaiAuth:
      provider.requires_openai_auth === true ||
      (id === 'openai' && provider.requires_openai_auth !== false),
    apiBaseUrl: checkedBaseUrl(string(base)),
    chatgptBaseUrl: checkedBaseUrl(
      string(config.chatgpt_base_url ?? 'https://chatgpt.com/backend-api'),
    ),
  };
}

function checkedBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Local Codex base URL must use HTTP(S) without credentials, query or fragment',
    );
  return value.replace(/\/+$/, '');
}

/** Override task capabilities only; authentication, model and reasoning stay owned by Codex. */
export function executionOverrides(
  config: JsonObject,
  instructionFile?: string,
): string[] {
  const values = [
    'approval_policy="never"',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    'features.shell_tool=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
    'features.hooks=false',
    'features.codex_hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.memories=false',
    'features.enable_request_compression=false',
    'features.responses_websockets=false',
    'features.responses_websockets_v2=false',
    'skills.include_instructions=false',
    'notify=[]',
    'developer_instructions=""',
    'analytics.enabled=false',
  ];
  if (instructionFile) {
    values.push(`model_instructions_file=${JSON.stringify(instructionFile)}`);
    values.push(
      `experimental_compact_prompt_file=${JSON.stringify(instructionFile + '.compact')}`,
    );
    values.push(
      'compact_prompt="Summarize this RSI task, preserving its goal, authorized file names, tool results and output schema."',
    );
  }
  const servers = Object.keys(
    config.mcp_servers ? object(config.mcp_servers) : {},
  );
  values.push(
    `mcp_servers={${servers.map((name) => `${JSON.stringify(name)}={enabled=false,required=false}`).join(',')}}`,
  );
  return values.flatMap((value) => ['-c', value]);
}
