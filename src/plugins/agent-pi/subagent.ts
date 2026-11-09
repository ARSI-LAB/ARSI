import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentInput, RuntimeContext } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { roleNamePattern } from '../shared/agent-editing/project.js';

export async function readProjectRole(
  cwd: string,
  role: string,
): Promise<{ path: string; content: string }> {
  if (!new RegExp(roleNamePattern).test(role))
    throw new Error('Invalid agent role');
  const path = join(cwd, 'roles', `${role}.md`);
  if (!(await lstat(path)).isFile())
    throw new Error(`Invalid agent role file: ${role}`);
  return { path, content: await readFile(path, 'utf8') };
}

/** Role-based delegation shares the project while Manager owns the new session. */
export async function createProjectSubagentTool(
  parent: AgentInput,
  context: RuntimeContext,
): Promise<ToolDefinition | undefined> {
  const cwd = parent.cwd;
  const roles = await readdir(join(cwd, 'roles'), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    return [];
  });
  const names = roles
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .filter((name) => new RegExp(roleNamePattern).test(name))
    .sort();
  if (names.length === 0) return undefined;
  const parameters = {
    type: 'object',
    properties: {
      agent: { enum: names },
      task: { type: 'string', minLength: 1 },
    },
    required: ['agent', 'task'],
    additionalProperties: false,
  };
  return {
    name: 'subagent',
    label: 'Run a specialist',
    description:
      'Ask a configured specialist to investigate a task in this project and return its findings.',
    parameters,
    async execute(_id, input, toolSignal) {
      const signal = toolSignal
        ? AbortSignal.any([context.signal, toolSignal])
        : context.signal;
      signal.throwIfAborted();
      validate(parameters, input, 'subagent input');
      const task = object(input);
      const result = await context
        .extend({ signal })
        .invokeAgent(context.bindingId, {
          cwd,
          role: string(task.agent),
          goal: string(task.task),
          outputSchema: {
            type: 'object',
            properties: { findings: { type: 'string' } },
            required: ['findings'],
            additionalProperties: false,
          },
        });
      signal.throwIfAborted();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
}
