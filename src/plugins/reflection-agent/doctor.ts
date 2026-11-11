import type { DoctorContext } from '../../contracts/index.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';
import { reflectionReviewer } from './service.js';

export async function checkReflectionAgent(
  context: DoctorContext,
): Promise<void> {
  await checkAgentEditor(context, () => [
    { role: reflectionReviewer, promptField: 'bundledReviewer.prompt' },
  ]);
}
