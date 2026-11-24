import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import { runCommand } from '../shared/doctor/process.js';
import type { AgentClaudeCodeConfig } from './schema.js';

export interface ClaudeSandboxLaunch {
  args: string[];
  env?: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export const claudeSandboxRequests =
  ['initialize', 'get_settings', 'get_hooks_listing', 'mcp_status']
    .map((subtype) =>
      JSON.stringify({
        type: 'control_request',
        request_id: subtype,
        request: { subtype },
      }),
    )
    .join('\n') + '\n';

/** The CLI confirms the effective policy before receiving a user task. */
export function createClaudeSandboxVerifier(): (event: JsonObject) => boolean {
  const responses = new Map<string, JsonObject>();
  return (event) => {
    if (event.type === 'result' && event.is_error)
      throw new Error(
        'Claude Code sandbox is unavailable before model submission.',
      );
    if (event.type !== 'control_response') return false;
    const response = object(event.response);
    if (
      response.subtype !== 'success' ||
      typeof response.request_id !== 'string'
    )
      throw new Error(
        'Claude Code cannot verify the explicit sandbox configuration.',
      );
    responses.set(response.request_id, object(response.response));
    if (
      response.request_id === 'initialize' &&
      object(response.response).sandbox_enabled !== true
    )
      throw new Error(
        'Claude Code sandbox is unavailable before model submission.',
      );
    if (responses.size !== 4) return false;
    if (responses.get('initialize')?.sandbox_enabled !== true)
      throw new Error(
        'Claude Code sandbox is unavailable before model submission.',
      );
    const effective = object(responses.get('get_settings')?.effective);
    const permissions = object(effective.permissions);
    const sandbox = object(effective.sandbox);
    const filesystem = object(sandbox.filesystem);
    const hooks = responses.get('get_hooks_listing')?.hooks;
    const mcpServers = responses.get('mcp_status')?.mcpServers;
    if (
      effective.disableAllHooks !== true ||
      effective.disableWorkflows !== true ||
      effective.disableArtifact !== true ||
      effective.disableClaudeAiConnectors !== true ||
      Object.values(object(effective.enabledPlugins)).some(
        (value) => value !== false,
      ) ||
      permissions.defaultMode !== 'dontAsk' ||
      permissions.denyInsteadOfPrompting !== true ||
      permissions.blockWritesOutsideWorkingDirectories !== true ||
      JSON.stringify(permissions.additionalDirectories) !== '[]' ||
      sandbox.enabled !== true ||
      sandbox.failIfUnavailable !== true ||
      sandbox.allowUnsandboxedCommands !== false ||
      JSON.stringify(sandbox.excludedCommands) !== '[]' ||
      sandbox.allowNestedUserNamespaces !== false ||
      sandbox.enableWeakerNestedSandbox !== false ||
      filesystem.disabled !== false ||
      JSON.stringify(filesystem.allowWrite) !== '[]' ||
      !Array.isArray(hooks) ||
      hooks.length !== 0 ||
      !Array.isArray(mcpServers) ||
      mcpServers.length !== 0
    )
      throw new Error(
        'Claude Code effective settings conflict with the explicit sandbox.',
      );
    return true;
  };
}

/** Probe the same native settings used by execution without submitting a model task. */
export async function prepareClaudeSandbox(
  config: AgentClaudeCodeConfig,
  directory: string,
  signal: AbortSignal,
): Promise<ClaudeSandboxLaunch> {
  if (config.sandbox === undefined || config.sandbox === 'inherit')
    return { args: [], async dispose() {} };
  if (process.platform !== 'linux')
    throw new Error('Claude Code explicit sandbox modes require Linux.');
  const state = await mkdtemp(join(tmpdir(), 'rsi-claude-sandbox-'));
  const dispose = (): Promise<void> =>
    rm(state, { recursive: true, force: true });
  try {
    const credentialDirectory =
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    try {
      const credentials = await readFile(
        join(credentialDirectory, '.credentials.json'),
      );
      await writeFile(join(state, '.credentials.json'), credentials, {
        mode: 0o600,
      });
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    let nativeSettings: JsonObject = {};
    try {
      nativeSettings = object(
        JSON.parse(
          await readFile(join(credentialDirectory, 'settings.json'), 'utf8'),
        ),
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw new Error(
          'Claude Code user settings could not be read for sandbox authentication.',
        );
    }
    const providerEnvironment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(
      object(nativeSettings.env ?? {}),
    )) {
      if (
        /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_(?:USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|MAX_OUTPUT_TOKENS|EFFORT_LEVEL)|API_TIMEOUT_MS|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|DEFAULT_REGION|PROFILE)|GOOGLE_APPLICATION_CREDENTIALS|CLOUD_ML_REGION)$/.test(
          key,
        ) &&
        typeof value === 'string'
      )
        providerEnvironment[key] = value;
    }
    const writable = config.sandbox === 'workspace-write';
    // Native Read can render PDFs into unsandboxed scratch files; Grep reads text without rendering.
    const settings = {
      ...(typeof nativeSettings.model === 'string'
        ? { model: nativeSettings.model }
        : {}),
      ...(typeof nativeSettings.effortLevel === 'string'
        ? { effortLevel: nativeSettings.effortLevel }
        : {}),
      disableAllHooks: true,
      disableWorkflows: true,
      disableArtifact: true,
      disableClaudeAiConnectors: true,
      enabledPlugins: {},
      permissions: {
        defaultMode: 'dontAsk',
        denyInsteadOfPrompting: true,
        blockWritesOutsideWorkingDirectories: true,
        additionalDirectories: [],
        allow: writable ? ['Bash', 'Read', 'Glob', 'Grep'] : ['Glob', 'Grep'],
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        allowNestedUserNamespaces: false,
        enableWeakerNestedSandbox: false,
        excludedCommands: [],
        filesystem: { disabled: false, allowWrite: [] },
      },
    };
    const args = [
      '--safe-mode',
      '--restricted',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      writable ? 'Read,Glob,Grep,Bash' : 'Glob,Grep',
      '--settings',
      JSON.stringify(settings),
    ];
    const env = {
      ...providerEnvironment,
      ...process.env,
      CLAUDE_CONFIG_DIR: state,
    };
    const command = await nativeAgentCommand(config.executable ?? 'claude');
    let stdout: string;
    try {
      ({ stdout } = await runCommand(
        command.command,
        [
          ...command.args,
          '-p',
          '--verbose',
          '--no-session-persistence',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          ...args,
        ],
        {
          cwd: directory,
          env,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          input: claudeSandboxRequests,
        },
      ));
    } catch {
      signal.throwIfAborted();
      throw new Error(
        'Claude Code sandbox preflight did not complete; check the CLI and sandbox prerequisites.',
      );
    }
    const verify = createClaudeSandboxVerifier();
    let verified = false;
    for (const line of stdout.trim().split('\n')) {
      let event: JsonObject;
      try {
        event = object(JSON.parse(line));
      } catch {
        throw new Error(
          'Claude Code sandbox preflight returned invalid protocol output.',
        );
      }
      verified = verify(event) || verified;
    }
    if (!verified)
      throw new Error(
        'Claude Code could not verify the explicit sandbox configuration.',
      );
    return { args, env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
