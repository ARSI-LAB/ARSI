import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';

export async function runClaudeProcess(
  executable: string,
  args: string[],
  directory: string,
  input: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  await runNativeJsonProcess(
    executable,
    args,
    directory,
    input,
    signal,
    onLine,
    {
      label: 'Claude Code',
    },
  );
}
