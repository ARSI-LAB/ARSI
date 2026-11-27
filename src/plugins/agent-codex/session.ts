import { setTimeout as delay } from 'node:timers/promises';
import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/agent-result.js';
import { codexObservations } from './observations.js';
import type {
  AgentObservation,
  AgentProcessLauncher,
} from '../../contracts/index.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectMarker,
  roleNamePattern,
} from '../shared/agent-editing/project.js';
import type {
  AgentInput,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
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
interface SessionOptions {
  executable: string;
  directory: string;
  options: string[];
  request: AgentInput;
  signal: AbortSignal;
  record: (event: AgentObservation) => void;
  launch: AgentProcessLauncher;
}
export async function runSession(options: SessionOptions): Promise<JsonObject> {
  const { signal } = options;
  const backoffMs = [250, 500];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let submitted = false;
    try {
      return await runSessionAttempt(options, () => {
        submitted = true;
      });
    } catch (error) {
      signal.throwIfAborted();
      const wait = backoffMs[attempt];
      if (
        submitted ||
        wait === undefined ||
        !(error instanceof Error) ||
        ('status' in error && error.status === 'unknown')
      )
        throw error;
      options.record({
        runId: 'main',
        event: {
          type: 'startup.retrying',
          reason: 'Retrying Codex startup before turn submission.',
        },
      });
      await delay(wait, undefined, { signal });
    }
  }
}

async function runSessionAttempt(
  options: SessionOptions,
  markSubmitted: () => void,
): Promise<JsonObject> {
  const { request, record } = options;
  const observe = observeNative(
    codexObservations(record),
    record,
    options.signal,
  );
  let threadId = '';
  let response = '';
  let result: JsonObject | undefined;
  const platform = process.platform;
  const launchConfig = [
    'approval_policy="never"',
    `project_root_markers=[${JSON.stringify(projectMarker)}]`,
  ];
  if (platform === 'win32')
    launchConfig.push('sandbox_workspace_write.network_access=true');
  const startThread = (
    send: (message: JsonValue) => void,
    policy: JsonObject,
  ): void => {
    send({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: options.directory,
        ephemeral: !hasRoles,
        ...policy,
      },
    });
  };
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
  let hasRoles = false;
  for (const role of roles) {
    const name = role.name.slice(0, -5);
    if (
      role.isFile() &&
      role.name.endsWith('.toml') &&
      new RegExp(roleNamePattern).test(name)
    ) {
      hasRoles = true;
      launchConfig.push(
        `agents.${name}.config_file=${JSON.stringify(join(agentsDir, role.name))}`,
      );
    }
  }
  if (hasRoles)
    launchConfig.push('agents.max_depth=1', 'features.multi_agent=true');
  await runCodexProcess(
    options.executable,
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'arsi', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    }) + '\n',
    (line, send) => {
      const message = object(JSON.parse(line));
      observe(message, threadId);
      if (message.error)
        throw new Error(
          `Codex app-server request failed${nativeError(message.error)}`,
        );
      if (message.method === undefined && message.id === 1) {
        send({ method: 'initialized' });
        if (platform === 'win32') {
          send({
            id: 4,
            method: 'config/read',
            params: { cwd: options.directory },
          });
        } else {
          startThread(send, {});
        }
      } else if (
        platform === 'win32' &&
        message.method === undefined &&
        message.id === 4
      ) {
        const configRead = object(message.result, 'Codex config/read');
        const config = object(configRead.config, 'Codex config');
        const origins = object(configRead.origins, 'Codex config origins');
        const windows =
          config.windows == null
            ? {}
            : object(config.windows, 'Codex Windows config');
        if (
          windows.sandbox === 'elevated' ||
          windows.sandbox === 'unelevated'
        ) {
          startThread(send, { sandbox: 'workspace-write' });
        } else if (
          windows.sandbox == null &&
          !Object.hasOwn(origins, 'windows.sandbox')
        ) {
          startThread(send, { sandbox: 'danger-full-access' });
        } else {
          throw new Error(
            'Cannot determine the configured Windows Codex sandbox',
          );
        }
      } else if (message.method === undefined && message.id === 2) {
        const configuration = object(message.result);
        threadId = string(object(configuration.thread).id);
        record({
          runId: 'main',
          native: { sessionId: threadId },
          event: {
            type: 'session.started',
            sessionId: threadId,
            ...(typeof configuration.model === 'string'
              ? { model: configuration.model }
              : {}),
          },
        });
        markSubmitted();
        record({
          runId: 'main',
          native: { sessionId: threadId },
          event: {
            type: 'task.submitted',
            text: request.message,
            outputSchema: request.outputSchema,
          },
        });
        send({
          id: 3,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: request.message }],
            outputSchema: request.outputSchema,
            cwd: options.directory,
          },
        });
      } else if (message.method === 'item/completed') {
        const params = object(message.params);
        if (typeof params.threadId === 'string' && params.threadId !== threadId)
          return;
        const item = object(params.item);
        if (item.type === 'agentMessage' && item.phase !== 'commentary') {
          if (typeof item.text !== 'string')
            throw new Error('Invalid Codex agent message');
          response = item.text;
        }
      } else if (message.method === 'turn/completed') {
        const params = object(message.params);
        if (typeof params.threadId === 'string' && params.threadId !== threadId)
          return;
        const turn = object(params.turn);
        if (turn.status !== 'completed')
          throw new Error(
            `Codex turn ${string(turn.status)}${nativeError(turn.error)}`,
          );
        result = parseAgentResult(response);
        return true;
      } else if (message.method && message.id !== undefined) {
        throw new Error(
          `Codex requires interactive input or approval (${string(message.method)}); this non-interactive Agent call cannot answer it`,
        );
      }
    },
    options.launch,
    launchConfig,
    options.options,
  );
  if (!result) throw new Error('Codex returned no validated output');
  return result;
}
