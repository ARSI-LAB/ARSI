import type { AgentProcessLauncher } from '../../contracts/index.js';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';

const minimumVersion = [2, 1, 248] as const;
export const minimumClaudeCodeVersion = minimumVersion.join('.');

export function supportsClientComposed(stdout: string): boolean {
  const version =
    /^(?:Claude Code[ \t]+)?v?(\d+)\.(\d+)\.(\d+)(?:[ \t]+\(Claude Code\))?[ \t\r]*$/m.exec(
      stdout.trim(),
    );
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  const patch = Number(version[3]);
  const [minimumMajor, minimumMinor, minimumPatch] = minimumVersion;
  return (
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor ||
        (minor === minimumMinor && patch >= minimumPatch)))
  );
}

export async function requireClaudeCodeVersion(
  executable: string,
  launch: AgentProcessLauncher,
): Promise<void> {
  const command = await nativeAgentCommand(executable);
  let supported = false;
  await launch(
    {
      executable: command.command,
      args: [...command.args, '--version'],
      input: '',
    },
    (line) => {
      supported ||= supportsClientComposed(line);
    },
  );
  if (!supported)
    throw new Error(
      'Claude Code ' +
        minimumClaudeCodeVersion +
        ' or newer is required for literal task messages.',
    );
}
