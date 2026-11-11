import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext } from '../../../contracts/index.js';
import { parseConfig } from '../../../shared/schema.js';
import { missingPath, resolveAgent } from '../doctor/checks.js';
import { loadAgentPrompt } from './index.js';
import { prepareAgentProject, type AgentRole } from './project.js';
import type { AgentEditingConfig } from './schema.js';

type CheckedRole = { role: AgentRole; promptField: string };

export async function checkAgentEditor<C extends AgentEditingConfig>(
  context: DoctorContext,
  checkedRoles: (config: C) => readonly CheckedRole[] = () => [],
): Promise<void> {
  const config = parseConfig<C>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  await context.check('agent-binding', async () => {
    resolveAgent(context, config.agentRef ?? 'agent.default');
  });
  let prompt = '';
  const roles = checkedRoles(config);
  const loaded = await context.check('editing-inputs', async (signal) => {
    try {
      signal.throwIfAborted();
      prompt = await loadAgentPrompt(config);
      for (const directory of config.skills ?? [])
        await readFile(join(directory, 'SKILL.md'), { signal });
      for (const { role } of roles) await readFile(role.prompt, { signal });
    } catch (error) {
      const path = missingPath(error);
      if (path) {
        const skillIndex = (config.skills ?? []).findIndex(
          (directory) =>
            path === directory || path === join(directory, 'SKILL.md'),
        );
        const checkedRole = roles.find(({ role }) => role.prompt === path);
        const field =
          path === config.prompt
            ? 'config.prompt'
            : skillIndex >= 0
              ? `config.skills.${skillIndex}`
              : (checkedRole?.promptField ?? 'config.guidance');
        context.missing({
          field,
          kind: path === config.guidance ? 'directory' : 'file',
          reference: path,
          checksNotRun: ['prepare-project'],
        });
      }
      throw error;
    }
  });
  if (!loaded) {
    context.unchecked(
      'prepare-project',
      'Editing inputs could not be loaded; project preparation did not run.',
    );
    return;
  }
  await context.check('prepare-project', async (signal) => {
    signal.throwIfAborted();
    await prepareAgentProject(
      context.runtime.extend({ signal }),
      prompt,
      {},
      config.skills ?? [],
      roles.map(({ role }) => role),
    );
    signal.throwIfAborted();
  });
}
