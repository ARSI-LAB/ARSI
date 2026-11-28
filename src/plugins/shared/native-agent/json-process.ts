import type {
  AgentObservation,
  AgentProcessLauncher,
  JsonObject,
} from '../../../contracts/index.js';
import { nativeAgentCommand } from './executable.js';

export async function runNativeJsonProcess(
  executable: string,
  args: string[],
  input: string,
  onLine: (line: string) => void,
  launch: AgentProcessLauncher,
  options: {
    record: (event: AgentObservation) => void;
    outputSchema: JsonObject;
    taskMessage?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const command = await nativeAgentCommand(executable);
  options.record({
    runId: 'main',
    event: {
      type: 'task.submitted',
      text: options.taskMessage ?? input,
      outputSchema: options.outputSchema,
    },
  });
  await launch(
    {
      executable: command.command,
      args: [...command.args, ...args],
      input,
      ...(options.env ? { env: options.env } : {}),
    },
    onLine,
  );
}
