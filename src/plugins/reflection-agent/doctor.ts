import type { DoctorContext, DoctorResult } from '../../contracts/index.js';
import { checkAgentEditor } from '../shared/agent-editing/doctor.js';
import { reflectionReviewer } from './service.js';

export function checkReflectionAgent(
  context: DoctorContext,
): Promise<DoctorResult> {
  return checkAgentEditor(context, () => [
    { role: reflectionReviewer, promptField: 'bundledReviewer.prompt' },
  ]);
}
