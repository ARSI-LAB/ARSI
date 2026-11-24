import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';
import { prepareClaudeSandbox } from './sandbox.js';

export function checkClaudeCodeAgent(context: DoctorContext): DoctorRule[] {
  const isExecutableCompatible = (signal: AbortSignal): Promise<boolean> =>
    isNativeAgentCompatible(
      context,
      'claude',
      ['--help'],
      [
        '--print',
        '--output-format',
        '--json-schema',
        '--permission-mode',
        '--tools',
        '--permission-prompts',
        '--verbose',
        '--no-session-persistence',
        '--disallowedTools',
        '--mcp-config',
        '--settings',
        '--strict-mcp-config',
      ],
      signal,
    );
  const isAuthenticated = (signal: AbortSignal): Promise<boolean> =>
    isClaudeAuthenticated(context, signal);

  return [
    {
      id: 'executable',
      check: isExecutableCompatible,
      reason: `The CLI lacks required CLI options. Check ${context.binding.name}.config.executable and upgrade the native CLI.`,
    },
    ...claudeSandboxRules(context),
    {
      id: 'doctor',
      reason:
        'Claude Code doctor exposes text diagnostics without a machine-readable health report; run claude doctor for installation details.',
    },
    {
      id: 'authentication',
      check: isAuthenticated,
      reason:
        'Claude Code has no valid authentication status. Check executable, upgrade the native CLI and configure authentication with claude auth login.',
    },
    {
      id: 'model-access',
      reason:
        'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
    },
  ];
}

function claudeSandboxRules(context: DoctorContext): DoctorRule[] {
  const mode = context.binding.config.sandbox;
  if (mode !== 'read-only' && mode !== 'workspace-write') return [];

  const isSandboxAvailable = async (signal: AbortSignal): Promise<boolean> => {
    const sandbox = await prepareClaudeSandbox(
      {
        executable: string(context.binding.config.executable ?? 'claude'),
        sandbox: mode,
      },
      context.directory,
      signal,
    );
    await sandbox.dispose();
    return true;
  };

  return [
    {
      id: 'sandbox',
      check: isSandboxAvailable,
      reason:
        'Claude Code could not verify the explicit sandbox prerequisites before authentication checks.',
    },
  ];
}

async function isClaudeAuthenticated(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<boolean> {
  const help = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--help'],
    signal,
  );
  if (!/(?:^|\s)--json(?:\s|$)/m.test(help)) return false;
  const stdout = await runNativeAgentCommand(
    context,
    'claude',
    ['auth', 'status', '--json'],
    signal,
    [0, 1],
  );
  try {
    return object(JSON.parse(stdout)).loggedIn === true;
  } catch {
    return false;
  }
}
