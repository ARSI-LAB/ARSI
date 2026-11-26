import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import type {
  AgentProcessLauncher,
  AgentLineHandler,
} from '../../contracts/index.js';
import { codexCommand } from './executable.js';
export async function runCodexProcess(
  executable: string,
  input: string,
  onLine: AgentLineHandler,
  launch: AgentProcessLauncher,
  configOverrides: string[],
  options: string[],
): Promise<void> {
  const command = codexCommand(executable);
  const native = await nativeAgentCommand(command.executable);
  const env = { ...process.env };
  if (process.platform === 'win32') {
    // A standalone process cannot use the Desktop app's package identity.
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === 'CODEX_WINDOWS_REGISTERED_CORE')
        delete env[name];
    }
  }
  await launch(
    {
      executable: native.command,
      args: [
        ...native.args,
        ...command.args,
        ...configOverrides.flatMap((value) => ['-c', value]),
        'app-server',
        ...options,
      ],
      env,
      input,
      interactive: true,
    },
    onLine,
  );
}
