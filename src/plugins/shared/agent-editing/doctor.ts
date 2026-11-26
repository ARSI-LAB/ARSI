import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorRule } from '../../../contracts/index.js';
import { missingInputError } from '../../../shared/doctor-check.js';
import { parseConfig } from '../../../shared/schema.js';
import { missingPath } from '../doctor/checks.js';
import { prepareAgentProject, type AgentRole } from './project.js';
import type { AgentEditingConfig } from './schema.js';

type CheckedRole = { role: AgentRole; promptField: string };

export function agentEditorDoctorRules<C extends AgentEditingConfig>(
  context: DoctorContext,
  checkedRoles: (config: C) => readonly CheckedRole[] = () => [],
): DoctorRule[] {
  context.signal.throwIfAborted();
  const config = parseConfig<C>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const skills = config.skills ?? [];
  const roles = checkedRoles(config);
  let prompt: string;
  async function areEditingInputsReadable(
    signal: AbortSignal,
  ): Promise<boolean> {
    prompt = await readEditingInputs(config, roles, signal);
    return true;
  }
  async function isProjectPrepared(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    await prepareAgentProject(
      context.runtime.extend({ signal }),
      prompt,
      {},
      skills,
      roles.map(({ role }) => role),
    );
    signal.throwIfAborted();
    return true;
  }
  return [
    {
      id: 'editing-inputs',
      check: areEditingInputsReadable,
      reason: 'Restore the configured prompt, skills and role prompt files.',
    },
    {
      id: 'prepare-project',
      check: isProjectPrepared,
      reason:
        'Correct the editing project configuration, including unique roles and skill names.',
    },
  ];
}

async function readEditingInputs(
  config: AgentEditingConfig,
  roles: readonly CheckedRole[],
  signal: AbortSignal,
): Promise<string> {
  async function readInput(path: string, field: string): Promise<string> {
    try {
      return await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
      if (missingPath(error))
        throw missingInputError(
          { field, kind: 'file', reference: path },
          error,
        );
      throw error;
    }
  }

  const prompt = await readInput(config.prompt, 'prompt');
  for (const [index, directory] of (config.skills ?? []).entries())
    await readInput(join(directory, 'SKILL.md'), `skills.${index}`);
  for (const { role, promptField } of roles)
    await readInput(role.prompt, promptField);
  return prompt;
}
