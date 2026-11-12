import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
import { string } from '../../../shared/json.js';
import { nativeAgentCommand } from '../native-agent/executable.js';
import { runCommand } from './process.js';

/** Check CLI compatibility without submitting a task or exposing native output. */
export async function checkNativeAgent(
  context: DoctorContext,
  command: string,
  helpArgs: string[],
  requiredFlags: string[],
): Promise<DoctorResult> {
  const available = await runDoctorCheck(
    'executable',
    async (signal) => {
      const stdout = await runNativeAgentCommand(
        context,
        command,
        helpArgs,
        signal,
      );
      const missing = requiredFlags.filter(
        (flag) =>
          !new RegExp(`(?:^|\\s|,)${flag}(?=[\\s,=]|$)`, 'm').test(stdout),
      );
      if (missing.length)
        throw new Error(
          `Upgrade ${command}; required CLI options are missing: ${missing.join(', ')}.`,
        );
    },
    { signal: context.signal },
  );
  return {
    checks: [
      available,
      {
        id: 'model-access',
        status: 'unchecked',
        reason:
          'Native preflight does not establish model-service reachability or model availability. Verify model access in the native client before running RSI.',
      },
    ],
  };
}

/** Run another native preflight command with the same executable resolution. */
export async function runNativeAgentCommand(
  context: DoctorContext,
  command: string,
  args: string[],
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  try {
    const launch = await nativeAgentCommand(
      string(context.binding.config.executable ?? command),
    );
    const { stdout } = await runCommand(
      launch.command,
      [...launch.args, ...args],
      {
        signal,
        cwd: context.directory,
        acceptedExitCodes,
      },
    );
    return stdout;
  } catch {
    throw new Error(
      `${context.binding.pluginId} native preflight failed; check the CLI installation, profile and credentials.`,
    );
  }
}
