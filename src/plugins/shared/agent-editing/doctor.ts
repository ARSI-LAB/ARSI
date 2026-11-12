import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorResult } from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
import { parseConfig } from '../../../shared/schema.js';
import { missingPath, resolveAgent } from '../doctor/checks.js';
import { loadAgentPrompt } from './index.js';
import { prepareAgentProject, type AgentRole } from './project.js';
import type { AgentEditingConfig } from './schema.js';

type CheckedRole = { role: AgentRole; promptField: string };

export async function checkAgentEditor<C extends AgentEditingConfig>(
  context: DoctorContext,
  checkedRoles: (config: C) => readonly CheckedRole[] = () => [],
): Promise<DoctorResult> {
  const config = parseConfig<C>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const options = { signal: context.signal };
  const agentBinding = await runDoctorCheck(
    'agent-binding',
    async () => resolveAgent(context, config.agentRef ?? 'agent.default'),
    options,
  );
  const missingResources: NonNullable<DoctorResult['missingResources']> = [];
  let prompt = '';
  const roles = checkedRoles(config);
  const loaded = await runDoctorCheck(
    'editing-inputs',
    async (signal) => {
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
          missingResources.push({
            field,
            kind: path === config.guidance ? 'directory' : 'file',
            reference: path,
            checksNotRun: ['prepare-project'],
          });
        }
        throw error;
      }
    },
    options,
  );
  if (loaded.status !== 'passed') {
    return {
      checks: [
        agentBinding,
        loaded,
        {
          id: 'prepare-project',
          status: 'unchecked',
          reason:
            'Editing inputs could not be loaded; project preparation did not run.',
        },
      ],
      missingResources,
    };
  }
  const prepared = await runDoctorCheck(
    'prepare-project',
    async (signal) => {
      signal.throwIfAborted();
      await prepareAgentProject(
        context.runtime.extend({ signal }),
        prompt,
        {},
        config.skills ?? [],
        roles.map(({ role }) => role),
      );
      signal.throwIfAborted();
    },
    options,
  );
  return { checks: [agentBinding, loaded, prepared] };
}
