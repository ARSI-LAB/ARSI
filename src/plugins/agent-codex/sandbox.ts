import type {
  AgentProcessLauncher,
  JsonObject,
} from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { runCodexProcess } from './process.js';
import { runCommand } from '../shared/doctor/process.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write';

const disabledFeatures = [
  'hooks',
  'plugins',
  'apps',
  'browser_use',
  'computer_use',
  'multi_agent',
  'multi_agent_v2',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'js_repl',
  'js_repl_tools_only',
  'in_app_local_automation',
];

export interface CodexSandbox {
  config: string[];
  policy: JsonObject;
}

export function codexSandboxPolicy(
  mode: CodexSandboxMode,
  directory: string,
): JsonObject {
  return mode === 'read-only'
    ? { type: 'readOnly' }
    : {
        type: 'workspaceWrite',
        writableRoots: [directory],
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: false,
      };
}

export function validateCodexSandboxConfig(config: JsonObject): void {
  if (
    Object.values(object(config.mcp_servers ?? {})).some(
      (server) => object(server).enabled !== false,
    )
  )
    throw new Error('Codex sandbox could not disable host MCP servers');
  const roots = object(
    config.sandbox_workspace_write,
    'Codex sandbox workspace',
  ).writable_roots;
  if (!Array.isArray(roots) || roots.length !== 0)
    throw new Error('Codex sandbox could not remove inherited writable roots');
  if (!Array.isArray(config.notify) || config.notify.length !== 0)
    throw new Error(
      'Codex sandbox could not disable host notification commands',
    );
  const features = object(config.features, 'Codex sandbox features');
  if (disabledFeatures.some((name) => features[name] !== false))
    throw new Error(
      'Codex sandbox could not disable host extensions and delegation',
    );
}

export function validateCodexSandbox(
  mode: CodexSandboxMode,
  directory: string,
  configuration: JsonObject,
): void {
  const sandbox = object(configuration.sandbox, 'Codex sandbox');
  if (configuration.approvalPolicy !== 'never')
    throw new Error(
      'Codex sandbox requires non-interactive approval policy never',
    );
  if (mode === 'read-only') {
    if (sandbox.type !== 'readOnly')
      throw new Error('Codex returned a different sandbox mode');
    return;
  }
  if (
    sandbox.type !== 'workspaceWrite' ||
    !Array.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.some((root) => root !== directory)
  )
    throw new Error('Codex returned wider sandbox writable roots');
}

/** Exercise the native executor before any model turn, without changing host settings. */
export async function prepareCodexSandbox(options: {
  mode: CodexSandboxMode;
  executable: string;
  directory: string;
  signal: AbortSignal;
  launch?: AgentProcessLauncher;
}): Promise<CodexSandbox> {
  if (process.platform !== 'linux')
    throw new Error('Explicit Codex sandbox is supported only on Linux');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15000)]);
  signal.throwIfAborted();
  const launch: AgentProcessLauncher =
    options.launch ??
    (async (spec, onLine) => {
      await runCommand(spec.executable, spec.args, {
        signal,
        cwd: options.directory,
        env: spec.env,
        input: spec.input,
        onLine,
      });
    });
  const config = [
    `sandbox_mode=${JSON.stringify(options.mode)}`,
    'approval_policy="never"',
    'sandbox_workspace_write.writable_roots=[]',
    'sandbox_workspace_write.exclude_slash_tmp=false',
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
    'notify=[]',
    'mcp_servers={}',
    ...disabledFeatures.map((name) => `features.${name}=false`),
  ];
  const policy = codexSandboxPolicy(options.mode, options.directory);
  let verified = false;
  try {
    await runCodexProcess(
      options.executable,
      JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'arsi-sandbox-check', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        },
      }) + '\n',
      (line, send) => {
        const message = object(JSON.parse(line));
        if (message.error)
          throw new Error('Codex sandbox preflight request failed');
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({
            id: 2,
            method: 'config/read',
            params: { cwd: options.directory },
          });
        } else if (message.id === 2) {
          const native = object(object(message.result).config);
          validateCodexSandboxConfig(native);
          if (options.mode === 'workspace-write')
            policy.networkAccess =
              object(native.sandbox_workspace_write).network_access === true;
          send({
            id: 3,
            method: 'command/exec',
            params: {
              command: ['/bin/true'],
              cwd: options.directory,
              sandboxPolicy: policy,
              timeoutMs: 10000,
            },
          });
        } else if (message.id === 3) {
          if (object(message.result).exitCode !== 0)
            throw new Error('Codex native sandbox is unavailable');
          verified = true;
          return true;
        }
      },
      launch,
      config,
    );
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'Codex sandbox preflight failed; check native sandbox support and effective extension settings',
    );
  }
  if (!verified) throw new Error('Codex native sandbox could not be verified');
  return { config, policy };
}
