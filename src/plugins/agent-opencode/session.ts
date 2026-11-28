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

export function addInlineInstructions(
  env: NodeJS.ProcessEnv,
  paths: string[],
): NodeJS.ProcessEnv | undefined {
  const content = env.OPENCODE_CONFIG_CONTENT?.trim();
  let config: JsonObject = {};
  if (content) {
    try {
      // Match strings first so JSONC markers inside values stay intact.
      const json = content
        .replace(
          /"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
          (token) => (token.startsWith('"') ? token : ' '),
        )
        .replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g, (token) =>
          token === ',' ? '' : token,
        );
      config = object(JSON.parse(json));
    } catch {
      return undefined;
    }
  }
  const instructions =
    config.instructions === undefined ? [] : config.instructions;
  if (
    !Array.isArray(instructions) ||
    instructions.some((item) => typeof item !== 'string')
  )
    return undefined;
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      instructions: [...instructions, ...paths],
    }),
  };
}

export async function runSession(options: {
  config: AgentOpenCodeConfig;
  env: NodeJS.ProcessEnv;
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
  await runNativeJsonProcess(
    config.executable ?? 'opencode',
    args,
    request.message,
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
      env: options.env,
    },
  );
  if (finalMessage === undefined || finalReason !== 'stop')
    throw new Error(
      'OpenCode returned no successfully completed final answer.',
    );
  return parseAgentResult(messages.get(finalMessage) ?? '');
}
