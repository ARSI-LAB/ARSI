import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import {
  isNativeAgentCompatible,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';
import { minimumClaudeCodeVersion, supportsClientComposed } from './version.js';

export function checkClaudeCodeAgent(context: DoctorContext): DoctorRule[] {
  const isExecutableCompatible = async (
    signal: AbortSignal,
  ): Promise<boolean> => {
    // Both child processes must release their working directory before this check returns.
    const [compatible, version] = await Promise.allSettled([
      isNativeAgentCompatible(
        context,
        'claude',
        ['--help'],
        [
          '--print',
          '--input-format',
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
      ),
      runNativeAgentCommand(context, 'claude', ['--version'], signal),
    ]);
    if (compatible.status === 'rejected') throw compatible.reason;
    if (version.status === 'rejected') throw version.reason;
    return compatible.value && supportsClientComposed(version.value);
  };
  const isAuthenticated = (signal: AbortSignal): Promise<boolean> =>
    isClaudeAuthenticated(context, signal);

  return [
    {
      id: 'executable',
      check: isExecutableCompatible,
      reason: `Claude Code requires version ${minimumClaudeCodeVersion} or newer and the required CLI options. Check ${context.binding.name}.config.executable and upgrade the native CLI.`,
    },
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
