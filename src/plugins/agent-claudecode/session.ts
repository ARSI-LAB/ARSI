import { observeNative } from '../shared/native-agent/observe.js';
import { claudeObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { AgentOutputError } from '../../contracts/runtime/errors.js';
import { object } from '../../shared/json.js';
import type { AgentClaudeCodeConfig } from './schema.js';
import { runNativeJsonProcess as runClaudeProcess } from '../shared/native-agent/json-process.js';

/** Native CLI owns model access, tools, structured-output generation and retries. */
export async function runSession(options: {
  config: AgentClaudeCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}): Promise<JsonObject> {
  const { config, request, record } = options;
  const observe = observeNative(
    claudeObservations(record),
    record,
    options.signal,
  );
  let result: JsonObject | undefined;
  let completed = false;
  // Keep native model/auth settings; constrain task tools independently.
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--forward-subagent-text',
    '--json-schema',
    JSON.stringify(request.outputSchema),
    ...(config.options ?? []),
  ];
  // Submit the fully composed user message without native slash-command routing.
  const frame = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: request.message },
    parent_tool_use_id: null,
    session_id: 'default',
    client_composed: true,
  });
  await runClaudeProcess(
    config.executable ?? 'claude',
    args,
    frame + '\n',
    (line) => {
      const event = object(JSON.parse(line));
      observe(event);
      if (event.type === 'result' && event.parent_tool_use_id == null) {
        if (completed)
          throw new Error('Claude Code returned multiple terminal results');
        completed = true;
        if (
          Array.isArray(event.permission_denials) &&
          event.permission_denials.length
        )
          throw new Error(
            'Claude Code requires permission for a denied tool; this non-interactive Agent call cannot approve it',
          );
        if (event.is_error !== false || event.subtype !== 'success')
          throw new Error(
            `Claude Code task failed (${typeof event.subtype === 'string' ? event.subtype : 'unknown status'})`,
          );
        const output = event.structured_output;
        if (output === undefined)
          throw new AgentOutputError(
            'Claude Code returned no structured output',
          );
        if (
          output === null ||
          typeof output !== 'object' ||
          Array.isArray(output)
        )
          throw new AgentOutputError(
            'Claude Code structured output must be a JSON object',
          );
        result = output;
      }
    },
    options.launch,
    {
      record,
      outputSchema: request.outputSchema,
      taskMessage: request.message,
    },
  );
  if (!result) throw new Error('Claude Code returned no validated output');
  return result;
}
