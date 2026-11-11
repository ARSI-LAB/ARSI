import type { DoctorContext } from '../../contracts/index.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';
import type { AgentEditingConfig } from './schema.js';

export async function checkProposerAgent(
  context: DoctorContext,
): Promise<void> {
  await checkAgentEditor<AgentEditingConfig>(context, (config) =>
    (config.subagents ?? []).map((role, index) => ({
      role,
      promptField: `config.subagents.${index}.prompt`,
    })),
  );
}
