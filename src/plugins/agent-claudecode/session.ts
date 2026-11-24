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
import {
  claudeSandboxRequests,
  createClaudeSandboxVerifier,
  prepareClaudeSandbox,
} from './sandbox.js';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';
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
  const explicit = config.sandbox !== undefined && config.sandbox !== 'inherit';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--forward-subagent-text',
    '--json-schema',
    JSON.stringify(request.outputSchema),
  ];
  if (config.model !== undefined) args.push('--model', config.model);
  if (config.effort !== undefined) args.push('--effort', config.effort);
  const prompt = JSON.stringify({
    goal: request.goal,
    instruction:
      'Read CLAUDE.md and the project instructions. Use native Skills and Agent delegation when appropriate. Return proposed changes through the requested result Schema; leave task input files unchanged. Return only the requested structured result.',
  });
  const consume = (line: string): void => {
    const event = object(JSON.parse(line));
    observe(event);
    if (event.type !== 'result' || event.parent_tool_use_id != null) return;
    if (completed)
      throw new Error('Claude Code returned multiple terminal results');
    completed = true;
    if (
      !explicit &&
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
      throw new AgentOutputError('Claude Code returned no structured output');
    if (output === null || typeof output !== 'object' || Array.isArray(output))
      throw new AgentOutputError(
        'Claude Code structured output must be a JSON object',
      );
    result = output;
  };
  const sandbox = await prepareClaudeSandbox(
    config,
    options.directory,
    options.signal,
  );
  try {
    if (explicit) {
      const command = await nativeAgentCommand(config.executable ?? 'claude');
      const verify = createClaudeSandboxVerifier();
      let submitted = false;
      await options.launch(
        {
          executable: command.command,
          args: [
            ...command.args,
            ...args,
            ...sandbox.args,
            '--input-format',
            'stream-json',
          ],
          env: sandbox.env,
          input: claudeSandboxRequests,
          interactive: true,
        },
        (line, send) => {
          const event = object(JSON.parse(line));
          if (!submitted) {
            observe(event);
            if (verify(event)) {
              submitted = true;
              record({
                runId: 'main',
                event: {
                  type: 'task.submitted',
                  text: prompt,
                  outputSchema: request.outputSchema,
                },
              });
              send({
                type: 'user',
                message: { role: 'user', content: prompt },
              });
            }
            return;
          }
          consume(line);
          if (completed) return true;
        },
      );
      if (!submitted)
        throw new Error(
          'Claude Code could not verify the explicit sandbox configuration.',
        );
    } else {
      await runClaudeProcess(
        config.executable ?? 'claude',
        args,
        prompt,
        consume,
        options.launch,
        { record, outputSchema: request.outputSchema },
      );
    }
  } finally {
    await sandbox.dispose();
  }
  if (!result) throw new Error('Claude Code returned no validated output');
  return result;
}
