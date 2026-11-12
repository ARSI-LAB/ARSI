import type { AgentInput, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { ResolvedAgentClaudeCodeConfig } from './schema.js';
import { runClaudeProcess } from './process.js';

/** Native CLI owns model access, tools, structured-output generation and retries. */
export async function runSession(options: {
  config: ResolvedAgentClaudeCodeConfig;
  directory: string;
  request: AgentInput;
  signal: AbortSignal;
  record: (type: string, data: unknown) => void;
}): Promise<JsonObject> {
  const { config, request, signal, record } = options;
  let result: JsonObject | undefined;
  let completed = false;
  // Keep native model/auth settings; constrain task tools independently.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    'Read,Glob,Grep,Skill,Agent',
    '--disallowedTools',
    'Write,Edit,NotebookEdit,Bash,PowerShell,mcp__*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
    '--json-schema',
    JSON.stringify(request.outputSchema),
  ];
  if (config.model !== undefined) args.push('--model', config.model);
  if (config.effort !== undefined) args.push('--effort', config.effort);
  await runClaudeProcess(
    config.executable,
    args,
    options.directory,
    JSON.stringify({
      goal: request.goal,
      instruction:
        'Read CLAUDE.md and the project instructions. Use native Skills and Agent delegation when appropriate. Return only the requested structured result; RSI applies proposed edits.',
    }),
    signal,
    (line) => {
      const event = object(JSON.parse(line));
      if (event.type === 'system' && event.subtype === 'init') {
        record('session_started', {
          model: event.model ?? null,
          tools: event.tools ?? [],
          version: event.claude_code_version ?? null,
        });
      } else if (event.type === 'assistant') {
        const message = object(event.message);
        if (Array.isArray(message.content))
          for (const raw of message.content) {
            const item = object(raw);
            if (item.type === 'tool_use')
              record('tool_use', {
                name: item.name ?? null,
                subagent:
                  event.parent_tool_use_id !== null &&
                  event.parent_tool_use_id !== undefined,
              });
          }
      } else if (event.type === 'result') {
        if (completed)
          throw new Error('Claude Code returned multiple terminal results');
        completed = true;
        if (event.usage !== undefined)
          record('token_usage', {
            usage: event.usage,
            models: event.modelUsage ?? null,
          });
        record('session_completed', { subtype: event.subtype ?? null });
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
        if (event.structured_output === undefined)
          throw new Error('Claude Code returned no structured output');
        validate(request.outputSchema, event.structured_output, 'agent output');
        result = object(event.structured_output);
        record('validation_succeeded', {});
      }
    },
  );
  if (!result) throw new Error('Claude Code returned no validated output');
  return result;
}
