import { randomUUID } from 'node:crypto';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { runNativeJsonProcess } from '../shared/native-agent/json-process.js';
import type { ResolvedAgentOpenCodeConfig } from './schema.js';

/** Retain native provider settings; a unique primary agent owns task permissions. */
export function launchEnvironment(
  agent: string,
  directory: string,
): NodeJS.ProcessEnv {
  let inherited: JsonObject = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    try {
      inherited = object(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT));
    } catch {
      throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object.');
    }
  }
  const agents = inherited.agents === undefined ? {} : object(inherited.agents);
  return {
    ...process.env,
    // OpenCode run prioritizes PWD over the process working directory.
    PWD: directory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inherited,
      agents: {
        ...agents,
        [agent]: {
          description: 'Read task files and return a structured RSI proposal.',
          mode: 'primary',
          permissions: [
            { action: '*', resource: '*', effect: 'deny' },
            ...['read', 'glob', 'grep', 'skill'].map((action) => ({
              action,
              resource: '*',
              effect: 'allow',
            })),
          ],
        },
      },
    }),
  };
}

export async function runSession(options: {
  config: ResolvedAgentOpenCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (type: string, data: unknown) => void;
}): Promise<JsonObject> {
  const { config, request, signal, record } = options;
  const agent = `rsi-${randomUUID()}`;
  const args = [
    'run',
    '--standalone',
    '--format',
    'json',
    '--archived',
    '--agent',
    agent,
  ];
  if (config.model !== undefined) args.push('--model', config.model);
  const messages = new Map<string, string>();
  const usageRecorded = new Set<string>();
  let sessionId: string | undefined;
  let finalMessage: string | undefined;
  let finalReason: string | undefined;
  await runNativeJsonProcess(
    config.executable,
    args,
    options.directory,
    JSON.stringify({
      goal: request.goal,
      instruction:
        'Read AGENTS.md and the project instructions. The project is read-only. Return proposed edits rather than modifying files. Your final answer must be only a JSON object matching outputSchema, without Markdown or prose.',
      outputSchema: request.outputSchema,
    }),
    signal,
    (line) => {
      let event: JsonObject;
      try {
        event = object(JSON.parse(line));
      } catch {
        throw new Error('OpenCode emitted invalid JSON protocol output.');
      }
      if (event.type === 'error')
        throw new Error(
          'OpenCode reported a native execution error; inspect native logs.',
        );
      if (
        !['text', 'step_start', 'step_finish', 'tool_use'].includes(
          String(event.type),
        )
      )
        return;
      const id = string(event.sessionID);
      if (sessionId === undefined) {
        sessionId = id;
        record('session_started', { sessionId });
      } else if (id !== sessionId)
        throw new Error('OpenCode emitted an unexpected session.');
      const part = object(event.part);
      const messageId = string(part.messageID);
      if (event.type === 'text') {
        const text = (messages.get(messageId) ?? '') + string(part.text);
        if (Buffer.byteLength(text) > 16 * 1024 * 1024)
          throw new Error('OpenCode response exceeds 16 MiB.');
        messages.set(messageId, text);
      } else if (event.type === 'step_finish') {
        finalMessage = messageId;
        finalReason = string(part.reason);
        if (!usageRecorded.has(messageId)) {
          usageRecorded.add(messageId);
          const tokens = part.tokens === undefined ? {} : object(part.tokens);
          record('token_usage', {
            usage: Object.fromEntries(
              ['input', 'output', 'reasoning']
                .filter((key) => typeof tokens[key] === 'number')
                .map((key) => [key, tokens[key]]),
            ),
          });
        }
      } else if (event.type === 'tool_use') {
        record('tool_use', {
          name: typeof part.tool === 'string' ? part.tool : null,
        });
      }
    },
    { label: 'OpenCode', env: launchEnvironment(agent, options.directory) },
  );
  if (finalMessage === undefined || finalReason !== 'stop')
    throw new Error(
      'OpenCode returned no successfully completed final answer.',
    );
  const text = messages.get(finalMessage)?.trim() ?? '';
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  let output: unknown;
  try {
    output = JSON.parse(fenced?.[1] ?? text);
  } catch {
    throw new Error('OpenCode final response is not valid JSON.');
  }
  validate(request.outputSchema, output, 'agent output');
  record('validation_succeeded', {});
  return object(output);
}
