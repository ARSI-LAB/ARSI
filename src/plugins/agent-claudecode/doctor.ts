import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import { object } from '../../shared/json.js';
import {
  checkNativeAgent,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkClaudeCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const result = await checkNativeAgent(
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
  );
  if (result.checks[0].status !== 'passed') return result;
  result.checks.splice(1, 0, {
    id: 'doctor',
    status: 'unchecked',
    reason:
      'Claude Code doctor exposes text diagnostics without a machine-readable health report; run claude doctor for installation details.',
  });
  result.checks.splice(
    2,
    0,
    await runDoctorCheck(
      'authentication',
      async (signal) => {
        const help = await runNativeAgentCommand(
          context,
          'claude',
          ['auth', 'status', '--help'],
          signal,
        );
        if (!/(?:^|\s)--json(?:\s|$)/m.test(help))
          throw new Error(
            'Claude Code does not advertise JSON authentication status; upgrade the CLI.',
          );
        const stdout = await runNativeAgentCommand(
          context,
          'claude',
          ['auth', 'status', '--json'],
          signal,
          [0, 1],
        );
        let loggedIn: unknown;
        try {
          loggedIn = object(JSON.parse(stdout)).loggedIn;
        } catch {
          throw new Error(
            'Claude Code returned invalid authentication status.',
          );
        }
        if (typeof loggedIn !== 'boolean')
          throw new Error(
            'Claude Code returned unsupported authentication status.',
          );
        if (!loggedIn)
          throw new Error(
            'Claude Code has no active authentication; configure authentication in the native CLI.',
          );
      },
      { signal: context.signal },
    ),
  );
  return result;
}
