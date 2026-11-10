import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectMarker,
  roleNamePattern,
} from '../shared/agent-editing/project.js';
import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { runCodexProcess } from './process.js';

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

/** Codex owns native tools, configuration and recovery. */
export async function runSession(options: {
  executable: string;
  directory: string;
  model?: string;
  reasoningEffort?: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (type: string, data: unknown) => void;
}): Promise<JsonObject> {
  const { request, signal, record } = options;
  let threadId = '';
  let turnId = '';
  let response = '';
  let result: JsonObject | undefined;
  const permissions = `rsi-agent-${randomUUID()}`;
  const prompt = JSON.stringify({
    goal: request.goal,
    instruction:
      'Use the project instructions and return the requested JSON result.',
  });
  const launchConfig = [
    `project_root_markers=[${JSON.stringify(projectMarker)}]`,
    `default_permissions=${JSON.stringify(permissions)}`,
    `permissions.${permissions}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"="read"}`,
  ];
  const agentsDir = join(options.directory, '.codex', 'agents');
  const roles = await readdir(agentsDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      return [];
    },
  );
  for (const role of roles) {
    const name = role.name.slice(0, -5);
    if (
      role.isFile() &&
      role.name.endsWith('.toml') &&
      new RegExp(roleNamePattern).test(name)
    )
      launchConfig.push(
        `agents.${name}.config_file=${JSON.stringify(join(agentsDir, role.name))}`,
      );
  }
  if (roles.length)
    launchConfig.push('agents.max_depth=1', 'features.multi_agent=true');
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
    (line, send) => {
      const message = object(JSON.parse(line));
      if (message.error)
        throw new Error(
          `Codex app-server request failed${nativeError(message.error)}`,
        );
      if (message.method === undefined && message.id === 1) {
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'thread/start',
          params: {
            cwd: options.directory,
            ephemeral: true,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : {
                  config: { model_reasoning_effort: options.reasoningEffort },
                }),
            permissions,
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
            cwd: options.directory,
          },
        });
      } else if (message.method === undefined && message.id === 3) {
        turnId = string(object(object(message.result).turn).id);
      } else if (message.method === 'item/tool/call') {
        const params = object(message.params);
        if (params.threadId !== threadId || params.turnId !== turnId) {
          send({
            id: message.id,
            result: {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: 'This tool request is outside the active root turn.',
                },
              ],
            },
          });
          return;
        }
        throw new Error('Codex requested an unsupported dynamic tool');
      } else if (message.method === 'item/completed') {
        const params = object(message.params);
        if (params.threadId !== threadId || params.turnId !== turnId) return;
        const item = object(params.item);
        if (item.type === 'agentMessage' && item.phase !== 'commentary') {
          if (typeof item.text !== 'string')
            throw new Error('Invalid Codex agent message');
          response = item.text;
        }
        if (item.type === 'contextCompaction') record('context_compaction', {});
      } else if (message.method === 'thread/tokenUsage/updated') {
        const params = object(message.params);
        if (params.threadId !== threadId || params.turnId !== turnId) return;
        const usage = object(params.tokenUsage);
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
        const params = object(message.params);
        const turn = object(params.turn);
        if (params.threadId !== threadId || turn.id !== turnId) return;
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
    launchConfig,
  );
  if (!result) throw new Error('Codex returned no validated output');
  return result;
}
