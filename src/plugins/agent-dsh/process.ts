import type { AgentProcessLauncher } from '../../contracts/index.js';
import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';
export async function runDshProcess(
  executable: string,
  options: string[],
  patch: string,
  prompt: string,
  onLine: (line: string) => void,
  launch: AgentProcessLauncher,
  observation: Parameters<typeof runNativeJsonProcess>[5],
): Promise<void> {
  await runNativeJsonProcess(
    executable,
    ['--profile', 'headless', '--patch', patch, '--json', ...options, '-'],
    prompt,
    onLine,
    launch,
    observation,
  );
}
