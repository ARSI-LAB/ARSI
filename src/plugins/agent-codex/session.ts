import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { runCodexProcess } from './process.js';
import { readFileSchema, readVirtualFile } from './virtual-files.js';

function nativeError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const error = object(value);
  const message = typeof error.message === 'string' ? error.message : '';
  const code =
    typeof error.code === 'string' || typeof error.code === 'number'
      ? ` [${error.code}]`
      : '';
  return message || code ? `: ${message}${code}` : '';
}

const readFileTool = {
  type: 'function',
  name: 'read_file',
  description:
    'Read only an authorized virtual snapshot file. Defaults to 200 lines and a bounded UTF-8 JSON response. Use startLine/lineCount for lines and byteOffset/nextByteOffset to page within a long line or selected range. path="." lists file names. Never accesses host paths.',
  inputSchema: readFileSchema,
};

/** Codex owns native tools, configuration and recovery; RSI supplies virtual snapshot access. */
export async function runSession(options: {
  executable: string;
  directory: string;
  model?: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (type: string, data: unknown) => void;
}): Promise<JsonObject> {
  const { request, signal, record } = options;
  let threadId = '';
  let response = '';
  let result: JsonObject | undefined;
  const prompt = JSON.stringify({
    instruction: request.prompt,
    goal: request.goal,
    input: request.input ?? {},
    files: Object.keys(request.files ?? {}),
    outputSchema: request.outputSchema,
  });
  await runCodexProcess(
    options.executable,
    options.directory,
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'ember_rsi', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    }) + '\n',
    signal,
    async (line, send) => {
      const message = object(JSON.parse(line));
      if (message.error)
        throw new Error(
          `Codex app-server request failed${nativeError(message.error)}`,
        );
      // Request IDs are independent in the two JSON-RPC directions.
      // A server tool request may reuse an outstanding/completed client request ID.
      if (message.method === undefined && message.id === 1) {
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'thread/start',
          params: {
            cwd: options.directory,
            ephemeral: true,
            ...(options.model === undefined ? {} : { model: options.model }),
            dynamicTools: [readFileTool],
          },
        });
      } else if (message.method === undefined && message.id === 2) {
        const configuration = object(message.result);
        threadId = string(object(configuration.thread).id);
        record('session_started', {
          model: configuration.model ?? null,
          provider: configuration.modelProvider ?? null,
          reasoningEffort: configuration.reasoningEffort ?? null,
        });
        send({
          id: 3,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: prompt }],
            outputSchema: request.outputSchema,
          },
        });
      } else if (message.method === 'item/tool/call') {
        const params = object(message.params);
        if (
          params.threadId !== threadId ||
          params.tool !== 'read_file' ||
          params.namespace
        )
          throw new Error('Codex requested a forbidden tool');
        signal.throwIfAborted();
        let text: string;
        let success = true;
        try {
          validate(readFileSchema, params.arguments, 'read_file arguments');
          const args = object(params.arguments);
          text = readVirtualFile(request.files ?? {}, args);
          record('virtual_file_read', {
            path: args.path,
            responseBytes: Buffer.byteLength(text),
          });
        } catch (error) {
          success = false;
          text =
            error instanceof Error
              ? error.message
              : 'Invalid virtual-file request';
        }
        send({
          id: message.id,
          result: { success, contentItems: [{ type: 'inputText', text }] },
        });
      } else if (message.method === 'item/completed') {
        const item = object(object(message.params).item);
        if (item.type === 'agentMessage' && item.phase !== 'commentary') {
          if (typeof item.text !== 'string')
            throw new Error('Invalid Codex agent message');
          response = item.text;
        }
        if (item.type === 'contextCompaction') record('context_compaction', {});
      } else if (message.method === 'thread/tokenUsage/updated') {
        const usage = object(object(message.params).tokenUsage);
        const counts = (value: unknown): JsonObject => {
          const raw = object(value);
          return Object.fromEntries(
            [
              'inputTokens',
              'cachedInputTokens',
              'outputTokens',
              'reasoningOutputTokens',
              'totalTokens',
            ]
              .filter((key) => typeof raw[key] === 'number')
              .map((key) => [key, raw[key]!]),
          );
        };
        record('token_usage', {
          total: counts(usage.total),
          last: counts(usage.last),
          modelContextWindow:
            typeof usage.modelContextWindow === 'number'
              ? usage.modelContextWindow
              : null,
        });
      } else if (message.method === 'turn/completed') {
        const turn = object(object(message.params).turn);
        if (turn.status !== 'completed')
          throw new Error(
            `Codex turn ${string(turn.status)}${nativeError(turn.error)}`,
          );
        const trimmed = response.trim();
        const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
        const output: unknown = JSON.parse(fenced?.[1] ?? trimmed);
        validate(request.outputSchema, output, 'agent output');
        result = object(output);
        record('validation_succeeded', {});
        return true;
      } else if (message.method && message.id !== undefined) {
        throw new Error(
          `Codex requires interactive input or approval (${string(message.method)}); this non-interactive Agent call cannot answer it`,
        );
      }
    },
  );
  if (!result) throw new Error('Codex returned no validated output');
  return result;
}
