import { randomUUID } from 'node:crypto';
import { object } from '../../shared/json.js';
import { launchEnvironment } from './session.js';
import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { runDoctorCheck } from '../../shared/doctor-check.js';
import {
  checkNativeAgent,
  runNativeAgentCommand,
} from '../shared/doctor/native-agent.js';

export async function checkOpenCodeAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  const result = await checkNativeAgent(
    context,
    'opencode',
    ['run', '--help'],
    ['--standalone', '--format', '--agent', '--model', '--archived'],
  );
  if (result.checks[0].status !== 'passed') return result;
  result.checks.splice(
    1,
    0,
    await runDoctorCheck(
      'version',
      async (signal) => {
        const version = await runNativeAgentCommand(
          context,
          'opencode',
          ['--version'],
          signal,
        );
        if (!/^opencode v2\.(\d+)\.(\d+)\s*$/.test(version.trim()))
          throw new Error(
            'Install OpenCode V2 using the official @opencode/cli package.',
          );
      },
      { signal: context.signal },
    ),
  );
  if (result.checks[1].status !== 'passed') return result;
  result.checks.splice(
    2,
    0,
    await runDoctorCheck(
      'configuration',
      async (signal) => {
        const agent = `rsi-doctor-${randomUUID()}`;
        const stdout = await runNativeAgentCommand(
          context,
          'opencode',
          ['debug', 'config', '--standalone'],
          signal,
          [0],
          launchEnvironment(agent, context.directory),
        );
        try {
          const entries: unknown = JSON.parse(stdout);
          if (
            !Array.isArray(entries) ||
            !entries.some((entry: unknown) => {
              const info = object(entry).info;
              if (info === undefined) return false;
              const agents = object(info).agents;
              return (
                agents !== undefined && Object.hasOwn(object(agents), agent)
              );
            })
          )
            throw new Error('missing agent');
        } catch {
          throw new Error(
            'OpenCode could not compose the native configuration with the RSI task agent.',
          );
        }
      },
      { signal: context.signal },
    ),
  );
  return result;
}
