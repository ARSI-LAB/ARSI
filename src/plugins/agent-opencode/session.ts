import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/native-agent/result.js';
import { openCodeObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';
import type { AgentOpenCodeConfig } from './schema.js';

/** Retain native provider settings and normal host environment. */
export function launchEnvironment(directory: string): NodeJS.ProcessEnv {
  return { ...process.env, PWD: directory };
}

export async function runSession(options: {
  config: AgentOpenCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}): Promise<JsonObject> {
  const { config, request, record } = options;
  const observe = observeNative(
    openCodeObservations(record),
    record,
    options.signal,
  );
  const args = [
    'run',
    '--standalone',
    '--format',
    'json',
    '--archived',
    ...(config.options ?? []),
  ];
  const messages = new Map<string, string>();
  let sessionId: string | undefined;
  let finalMessage: string | undefined;
  let finalReason: string | undefined;
  const prompt = JSON.stringify({
    goal: request.goal,
    instruction:
      'Read AGENTS.md and the project instructions. Return proposed changes through the requested result Schema; leave task input files unchanged. Your final answer must be only a JSON object matching outputSchema, without Markdown or prose.',
    outputSchema: request.outputSchema,
  });
  await runNativeJsonProcess(
    config.executable ?? 'opencode',
    args,
    prompt,
    (line) => {
      let event: JsonObject;
      try {
        event = object(JSON.parse(line));
      } catch {
        throw new Error('OpenCode emitted invalid JSON protocol output.');
      }
      const part = event.part === undefined ? {} : object(event.part);
      const source =
        typeof event.sessionID === 'string' ? event.sessionID : sessionId;
      sessionId ??= source;
      const messageKey =
        typeof part.messageID === 'string'
          ? JSON.stringify([
              source === sessionId ? null : source,
              part.messageID,
            ])
          : undefined;
      if (
        event.type === 'text' &&
        messageKey &&
        typeof part.text === 'string'
      ) {
        messages.set(messageKey, (messages.get(messageKey) ?? '') + part.text);
      }
      observe(
        event,
        event.type === 'step_finish' && messageKey
          ? (messages.get(messageKey) ?? null)
          : null,
      );
      if (source !== sessionId) return;
      if (event.type === 'step_finish') {
        finalMessage = messageKey;
        finalReason = typeof part.reason === 'string' ? part.reason : undefined;
      } else if (event.type === 'error') {
        record({
          runId: 'main',
          ...(sessionId ? { native: { sessionId } } : {}),
          event: {
            type: 'run.finished',
            status: 'failed',
            nativeStatus: 'error',
          },
        });
        throw new Error('OpenCode execution failed');
      }
    },
    options.launch,
    {
      record,
      outputSchema: request.outputSchema,
      env: launchEnvironment(options.directory),
    },
  );
  if (finalMessage === undefined || finalReason !== 'stop')
    throw new Error(
      'OpenCode returned no successfully completed final answer.',
    );
  return parseAgentResult(messages.get(finalMessage) ?? '');
}
